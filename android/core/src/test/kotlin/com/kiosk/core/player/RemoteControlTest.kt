package com.kiosk.core.player

import com.kiosk.core.model.DeviceReport
import com.kiosk.core.model.JobReport
import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Base64

/** Restart and See screen from the dashboard (0.13.0), as the TV hears and answers them. */
class RemoteControlTest {
    private val server = MockWebServer().apply { start() }
    private val repo = RemotePlayerRepository(server.url("/").toString(), "tv-token")

    @After fun stop() = server.shutdown()

    @Test fun readsRestartAndScreenshotRequests() = runTest {
        server.enqueue(MockResponse().setBody(
            """{"version":"1","items":[],"actions":{"resync":null,"update":null,"restart":{"id":"r1","kind":"device"},"screenshot":"s1"}}""",
        ))
        val actions = repo.playlist().actions
        assertEquals("r1", actions.restart?.id)
        assertEquals("device", actions.restart?.kind)
        assertEquals("s1", actions.screenshot)
    }

    @Test fun olderServersSendNeither() = runTest {
        server.enqueue(MockResponse().setBody("""{"version":"1","items":[],"actions":{"resync":null,"update":null}}"""))
        val actions = repo.playlist().actions
        assertNull(actions.restart)
        assertNull(actions.screenshot)
    }

    @Test fun sendsThePictureAsBase64() = runTest {
        server.enqueue(MockResponse().setBody("""{"ok":true}"""))
        val jpeg = byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 1, 2, 3)
        repo.sendScreenshot("s1", jpeg)
        val request = server.takeRequest()
        assertEquals("/api/player/screenshot/s1", request.path)
        assertEquals("Bearer tv-token", request.getHeader("Authorization"))
        val body = request.body.readUtf8()
        assertTrue(body, body.contains(Base64.getEncoder().encodeToString(jpeg)))
        assertTrue(body, !body.contains("error"))
    }

    @Test fun saysWhyThereIsNoPicture() = runTest {
        server.enqueue(MockResponse().setBody("""{"ok":true}"""))
        repo.sendScreenshot("s2", null, "Kiosk Player isn't on screen right now.")
        val body = server.takeRequest().body.readUtf8()
        assertTrue(body, body.contains("\"error\":\"Kiosk Player isn't on screen right now.\""))
        assertTrue(body, !body.contains("jpeg"))
    }

    @Test fun reportsTheRestartAndWhetherItCanRestartTheDevice() = runTest {
        server.enqueue(MockResponse().setBody("""{"ok":true,"version":"2"}"""))
        repo.heartbeat(null, null, "0.13.0", report = DeviceReport(canReboot = false, restart = JobReport("r1", "done")))
        val body = server.takeRequest().body.readUtf8()
        assertTrue(body, body.contains("\"can_reboot\":false"))
        assertTrue(body, body.contains("\"restart\":{\"id\":\"r1\",\"step\":\"done\""))
    }
}
