package com.kiosk.core.player

import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

class ServerFinderTest {
    private val server = MockWebServer()

    @After fun stop() = server.shutdown()

    @Test fun searchesTheWholeHomeNetworkExceptItself() {
        val list = ServerFinder.neighbours("192.168.1.37")
        assertEquals(253, list.size)
        assertEquals("192.168.1.1", list.first())
        assertEquals("192.168.1.254", list.last())
        assertFalse("192.168.1.37" in list)
    }

    @Test(expected = IllegalArgumentException::class)
    fun rejectsSomethingThatIsNotAnAddress() {
        ServerFinder.neighbours("fe80::1")
    }

    @Test fun recognisesAKioskServer() = runTest {
        server.enqueue(MockResponse().setBody("""{"kind":"kiosk-signage","role":"relay","server_id":"abc","site_name":"Orchard branch"}"""))
        val found = ServerFinder().ask(server.url("/").toString())
        assertEquals(FoundServer(server.url("/").toString(), "abc", "relay", "Orchard branch"), found)
    }

    @Test fun ignoresOtherDevices() = runTest {
        server.enqueue(MockResponse().setBody("""{"name":"some printer"}"""))
        server.enqueue(MockResponse().setResponseCode(404))
        val finder = ServerFinder()
        assertNull(finder.ask(server.url("/").toString()))
        assertNull(finder.ask(server.url("/").toString()))
        server.shutdown()
        assertNull(finder.ask(server.url("/").toString())) // nothing there at all
    }
}
