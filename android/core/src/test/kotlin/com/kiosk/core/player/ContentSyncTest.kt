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
import okhttp3.mockwebserver.SocketPolicy
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
    private var dropMidway = false // the connection really breaks halfway through the file
    private val ranges = mutableListOf<String?>()

    @Before fun start() {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val range = request.getHeader("Range")
                ranges += range
                val from = range?.removePrefix("bytes=")?.removeSuffix("-")?.toInt() ?: 0
                val end = cutAfter?.coerceAtMost(bytes.size) ?: bytes.size
                val body = Buffer().write(bytes.copyOfRange(from, end))
                val response = if (from > 0) MockResponse().setResponseCode(206).setBody(body) else MockResponse().setBody(body)
                if (dropMidway) response.socketPolicy = SocketPolicy.DISCONNECT_DURING_RESPONSE_BODY
                return response
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

    @Test fun downloadsFilesThatStartSoonAhead() = runTest {
        val sync = sync()
        sync.sync(PlayerPlaylist("1", items = emptyList(), upcoming = listOf(item)))
        assertTrue(sync.isReady(item)) // ready before it's due to play
    }

    // A real dropped connection (Wi-Fi blip, relay restarting) used to escape as a raw IOException,
    // which closed the TV app to the home screen. It must be an ordinary DownloadException.
    @Test fun aConnectionDroppedMidFileIsADownloadProblemNotACrash() = runTest {
        val sync = sync()
        dropMidway = true
        try {
            sync.sync(PlayerPlaylist("1", items = listOf(item)))
            fail("should report the broken download")
        } catch (e: DownloadException) {
            assertTrue(e.message!!.contains("connection lost"))
            assertFalse(sync.isReady(item))
        }
        dropMidway = false
        sync.sync(PlayerPlaylist("1", items = listOf(item)))
        assertTrue(sync.isReady(item))
        assertArrayEquals(bytes, sync.fileFor(item).readBytes())
    }

    @Test fun noServerAtAllIsADownloadProblemNotACrash() = runTest {
        val sync = ContentSync(OkHttpClient(), "http://127.0.0.1:1/", tmp.root)
        try {
            sync.sync(PlayerPlaylist("1", items = listOf(item)))
            fail("should report the download problem")
        } catch (e: DownloadException) {
            assertTrue(e.message!!.contains("connection lost"))
        }
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

    @Test fun keepsTheFileThatIsPlayingWhenACopyReplacesIt() = runTest {
        val playing = java.io.File(tmp.root, "7-oldmd5.mp4")
        playing.writeBytes(ByteArray(16))
        val sync = sync()
        sync.sync(PlayerPlaylist("1", items = listOf(item)), keepPlaying = listOf(playing))
        assertTrue(playing.exists())
        assertTrue(sync.isReady(item))
        sync.sync(PlayerPlaylist("2", items = listOf(item)))
        assertFalse(playing.exists())
        assertTrue(sync.isReady(item))
    }

    @Test fun freesOldFilesBeforeCheckingThereIsRoom() = runTest {
        val stale = java.io.File(tmp.root, "old-file.mp4")
        stale.writeBytes(ByteArray(32))
        val sync = ContentSync(OkHttpClient(), server.url("/").toString(), tmp.root) {
            if (stale.exists()) 0L else Long.MAX_VALUE
        }
        sync.sync(PlayerPlaylist("1", items = listOf(item)))
        assertTrue(sync.isReady(item))
        assertFalse(stale.exists())
    }

    @Test fun doesNotStartADownloadThatWouldFillTheDisk() = runTest {
        val sync = ContentSync(OkHttpClient(), server.url("/").toString(), tmp.root) { 1024 }
        try {
            sync.sync(PlayerPlaylist("1", items = listOf(item)))
            fail("should stop before filling the disk")
        } catch (e: DownloadException) {
            assertTrue(e.message!!.contains("free space"))
        }
        assertEquals(0, server.requestCount)
        assertFalse(sync.isReady(item))
    }

    @Test fun removesFilesNoLongerInThePlaylist() = runTest {
        val sync = sync()
        sync.sync(PlayerPlaylist("1", items = listOf(item)))
        sync.sync(PlayerPlaylist("2", items = emptyList()))
        assertTrue(tmp.root.listFiles()!!.isEmpty())
    }

    @Test fun resetSyncDownloadsEverythingAgainThenSwitchesOver() = runTest {
        val media = tmp.newFolder("media")
        val sync = ContentSync(OkHttpClient(), server.url("/").toString(), media)
        val playlist = PlayerPlaylist("1", items = listOf(item))
        sync.sync(playlist)
        val before = ranges.size
        var switched = false
        val progress = mutableListOf<Pair<Int, Int>>()
        assertTrue(sync.freshCopy(playlist, { d, t -> progress += d to t }, { switched = true }))
        assertEquals("downloaded again", before + 1, ranges.size)
        assertTrue(switched)
        assertTrue(sync.isReady(item))
        assertArrayEquals(bytes, sync.fileFor(item).readBytes())
        assertEquals(listOf(0 to 1, 1 to 1), progress)
        assertFalse("the fresh folder is gone", java.io.File(tmp.root, "media-fresh").exists())
        assertEquals(1, media.listFiles()!!.size)
    }

    @Test fun resetSyncWithoutRoomForTwoCopiesDeletesFirst() = runTest {
        val media = tmp.newFolder("media")
        // Room for nothing while the old file is there; plenty once it's gone.
        val sync = ContentSync(OkHttpClient(), server.url("/").toString(), media) {
            if (media.listFiles().isNullOrEmpty()) Long.MAX_VALUE / 2 else 0L
        }
        val playlist = PlayerPlaylist("1", items = listOf(item))
        sync.sync(playlist)
        assertFalse(sync.freshCopy(playlist))
        assertTrue(sync.isReady(item))
        assertFalse(java.io.File(tmp.root, "media-fresh").exists())
    }
}
