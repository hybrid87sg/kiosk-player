package com.kiosk.core.player

import com.kiosk.core.model.MediaType
import com.kiosk.core.model.PlayerItem
import com.kiosk.core.model.PlayerPlaylist
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.security.MessageDigest
import kotlin.random.Random

class ContentSyncTest {
    @get:Rule val tmp = TemporaryFolder()
    private val server = MockWebServer()
    private val bytes = Random(1).nextBytes(300_000)
    private val md5 = MessageDigest.getInstance("MD5").digest(bytes).joinToString("") { "%02x".format(it) }
    private val item = PlayerItem(7, MediaType.VIDEO, "promo.mp4", "/media/7", md5, bytes.size.toLong())
    private var cutAfter: Int? = null // pretend the connection drops after this many bytes
    private val ranges = mutableListOf<String?>()

    @Before fun start() {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val range = request.getHeader("Range")
                ranges += range
                val from = range?.removePrefix("bytes=")?.removeSuffix("-")?.toInt() ?: 0
                val end = cutAfter?.coerceAtMost(bytes.size) ?: bytes.size
                val body = Buffer().write(bytes.copyOfRange(from, end))
                return if (from > 0) MockResponse().setResponseCode(206).setBody(body) else MockResponse().setBody(body)
            }
        }
        server.start()
    }

    @After fun stop() = server.shutdown()

    private fun sync() = ContentSync(OkHttpClient(), server.url("/").toString(), tmp.root)

    @Test fun downloadsAndChecksTheFile() = runTest {
        val sync = sync()
        sync.sync(PlayerPlaylist("1", items = listOf(item)))
        assertTrue(sync.isReady(item))
        assertArrayEquals(bytes, sync.fileFor(item).readBytes())
    }

    @Test fun resumesAnInterruptedDownload() = runTest {
        val sync = sync()
        cutAfter = 100_000
        try {
            sync.sync(PlayerPlaylist("1", items = listOf(item)))
            fail("should report the incomplete download")
        } catch (e: DownloadException) {
            assertFalse(sync.isReady(item))
        }
        cutAfter = null
        sync.sync(PlayerPlaylist("1", items = listOf(item)))
        assertTrue(sync.isReady(item))
        assertEquals(listOf(null, "bytes=100000-"), ranges)
        assertArrayEquals(bytes, sync.fileFor(item).readBytes())
    }

    @Test fun rejectsADamagedFile() = runTest {
        val sync = sync()
        val wrong = item.copy(md5 = "0".repeat(32))
        try {
            sync.sync(PlayerPlaylist("1", items = listOf(wrong)))
            fail("should reject the file")
        } catch (e: DownloadException) {
            assertFalse(sync.isReady(wrong))
            assertTrue(tmp.root.listFiles()!!.isEmpty())
        }
    }

    @Test fun removesFilesNoLongerInThePlaylist() = runTest {
        val sync = sync()
        sync.sync(PlayerPlaylist("1", items = listOf(item)))
        sync.sync(PlayerPlaylist("2", items = emptyList()))
        assertTrue(tmp.root.listFiles()!!.isEmpty())
    }
}
