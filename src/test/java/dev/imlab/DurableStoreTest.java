package dev.imlab;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.sql.DriverManager;
import java.util.ArrayList;
import java.util.concurrent.Callable;
import java.util.concurrent.Executors;

import static org.junit.jupiter.api.Assertions.*;

/** 用真实 H2 文件库验证事务、持久化、权限和重放，不用 mock 数据库。 */
class DurableStoreTest {
    @TempDir Path directory;

    private String url(String name) {
        return "jdbc:h2:file:" + directory.resolve(name) + ";WRITE_DELAY=0";
    }

    @Test
    void committedOutboxSurvivesReopenAndCheckpointLossDoesNotDuplicateInbox() throws Exception {
        String jdbc = url("restart");
        String messageId;
        String eventId;
        long seq;
        try (var store = new DurableStore(jdbc)) {
            var commit = store.accept("alice", "bob", "k1", "durable", true);
            messageId = commit.message().messageId();
            eventId = store.pendingEvents(10).get(0);
            var first = store.materialize(eventId);
            assertTrue(first.checkpointLost());
            seq = first.message().seq();
            assertEquals(1, store.sync("bob", "", 10).messages().size());
            assertEquals("PENDING", store.inspect("alice").outbox().get(0).state());
        }
        try (var recovered = new DurableStore(jdbc)) {
            assertEquals(messageId, recovered.accept("alice", "bob", "k1", "durable", false).message().messageId());
            assertEquals(eventId, recovered.pendingEvents(10).get(0));
            var retry = recovered.materialize(eventId);
            assertFalse(retry.checkpointLost());
            assertEquals(seq, retry.message().seq());
            var snapshot = recovered.inspect("alice");
            assertEquals(1, snapshot.messages().size());
            assertEquals("DONE", snapshot.outbox().get(0).state());
            assertEquals(2, snapshot.outbox().get(0).attempts());
            assertNull(snapshot.outbox().get(0).lastError());
            assertEquals(1, recovered.sync("bob", "", 10).messages().size());
        }
    }

    @Test
    void messageInsertRollsBackIfOutboxInsertFails() throws Exception {
        String jdbc = url("rollback");
        try (var store = new DurableStore(jdbc); var connection = DriverManager.getConnection(jdbc, "sa", "")) {
            try (var statement = connection.createStatement()) {
                statement.execute("ALTER TABLE durable_outbox ADD CONSTRAINT injected_failure CHECK(FALSE)");
            }
            assertThrows(java.sql.SQLException.class, () -> store.accept("alice", "bob", "k1", "hello", false));
            assertTrue(store.inspect("alice").messages().isEmpty());
            assertTrue(store.pendingEvents(10).isEmpty());
            try (var statement = connection.createStatement()) {
                statement.execute("ALTER TABLE durable_outbox DROP CONSTRAINT injected_failure");
            }
            assertFalse(store.accept("alice", "bob", "k1", "hello", false).duplicate());
        }
    }

    @Test
    void concurrentRetriesKeepOneMessageAndConflictingPayloadIsRejected() throws Exception {
        try (var store = new DurableStore(url("concurrent"))) {
            var pool = Executors.newFixedThreadPool(8);
            try {
                var tasks = new ArrayList<Callable<DurableStore.Commit>>();
                for (int i = 0; i < 16; i++) tasks.add(() -> store.accept("alice", "bob", "k1", "hello", false));
                var results = pool.invokeAll(tasks);
                var ids = new java.util.HashSet<String>();
                int originals = 0;
                for (var future : results) {
                    var result = future.get();
                    ids.add(result.message().messageId());
                    if (!result.duplicate()) originals++;
                }
                assertEquals(1, ids.size());
                assertEquals(1, originals);
                assertEquals(1, store.inspect("alice").outbox().size());
                var conflict = assertThrows(DurableStore.ProtocolFault.class,
                        () -> store.accept("alice", "bob", "k1", "different", false));
                assertEquals("KEY_CONFLICT", conflict.code());
                assertFalse(store.accept("carol", "bob", "k1", "hello", false).duplicate());
            } finally { pool.shutdownNow(); }
        }
    }

    @Test
    void paginatedSyncAndReadAreBoundToRecipientAndPersistAcrossReopen() throws Exception {
        String jdbc = url("sync");
        String messageId;
        long readAt;
        try (var store = new DurableStore(jdbc)) {
            for (int i = 0; i < 5; i++) store.accept("alice", "bob", "k" + i, "message " + i, false);
            store.accept("carol", "dave", "private", "not for bob", false);
            for (String event : store.pendingEvents(20)) store.materialize(event);
            var first = store.sync("bob", "", 2);
            assertEquals(2, first.messages().size());
            assertTrue(first.hasMore());
            var second = store.sync("bob", first.nextCursor(), 2);
            assertEquals(2, second.messages().size());
            assertTrue(second.hasMore());
            assertTrue(second.messages().get(0).seq() > first.messages().get(1).seq());
            var third = store.sync("bob", second.nextCursor(), 2);
            assertEquals(1, third.messages().size());
            assertFalse(third.hasMore());
            assertTrue(store.sync("bob", third.nextCursor(), 2).messages().isEmpty());
            assertThrows(DurableStore.ProtocolFault.class, () -> store.sync("alice", first.nextCursor(), 2));
            assertThrows(DurableStore.ProtocolFault.class, () -> store.sync("bob", "v1.bob.999999", 2));
            assertEquals(0, store.inspect("nobody").messages().size());
            messageId = first.messages().get(0).messageId();
            assertThrows(DurableStore.ProtocolFault.class, () -> store.read("alice", messageId));
            readAt = store.read("bob", messageId).readAt();
            assertEquals(readAt, store.read("bob", messageId).readAt());
        }
        try (var recovered = new DurableStore(jdbc)) {
            assertEquals(readAt, recovered.read("bob", messageId).readAt());
        }
    }
}
