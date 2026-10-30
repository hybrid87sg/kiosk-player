package com.kiosk.core.data

import com.kiosk.core.model.Mounting
import com.kiosk.core.model.PlaylistEntry
import com.kiosk.core.model.PlayerSetup
import com.kiosk.core.model.ScreenShape
import com.kiosk.core.network.ApiException
import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class RemoteAdminRepositoryTest {
    private val server = MockWebServer().apply { start() }
    private var saved: String? = "start"
    private val repo = RemoteAdminRepository(server.url("/").toString(), "tok123") { saved = it }

    @After fun stop() = server.shutdown()

    @Test fun readsPlaylistsAndSendsTheToken() = runTest {
        server.enqueue(MockResponse().setBody("""[{"id":1,"name":"Lobby","orientation":"landscape","version":3,"item_count":2,"devices":[{"id":5,"name":"Back wall"}],"extra":"ignored"}]"""))
        val list = repo.playlists()
        assertEquals("Lobby", list[0].name)
        assertEquals(ScreenShape.LANDSCAPE, list[0].orientation)
        assertEquals("Back wall", list[0].devices[0].name)
        val request = server.takeRequest()
        assertEquals("/api/playlists", request.path)
        assertEquals("Bearer tok123", request.getHeader("Authorization"))
    }

    @Test fun showsTheServersErrorMessage() = runTest {
        server.enqueue(MockResponse().setResponseCode(409).setBody("""{"error":"Still playing on Back wall."}"""))
        try {
            repo.deletePlaylist(1)
            fail("expected an error")
        } catch (e: ApiException) {
            assertEquals("Still playing on Back wall.", e.message)
            assertEquals(409, e.status)
        }
    }

    @Test fun claimsADeviceWithItsSetup() = runTest {
        server.enqueue(MockResponse().setBody("""{"id":9,"name":"Front","location":"Lobby","orientation":"portrait_right","playlist_id":2,"online":false}"""))
        val device = repo.claimDevice("kiosk-pair:K7P29Q", PlayerSetup("Front", "Lobby", Mounting.PORTRAIT_RIGHT, 2))
        assertEquals(Mounting.PORTRAIT_RIGHT, device.orientation)
        val body = server.takeRequest().body.readUtf8()
        assertTrue(body, body.contains("\"code\":\"kiosk-pair:K7P29Q\""))
        assertTrue(body, body.contains("\"orientation\":\"portrait_right\""))
        assertTrue(body, body.contains("\"playlist_id\":2"))
    }

    @Test fun readsAndPreservesPlaylistItemPlayDates() = runTest {
        val startAt = 1_800_000_000_000L
        val endAt = startAt + 86_400_000L
        server.enqueue(MockResponse().setBody(
            """{"id":1,"name":"Lobby","orientation":"landscape","version":3,"item_count":1,"items":[{"media_id":7,"image_seconds":10,"filename":"promo.jpg","type":"image","start_at":$startAt,"end_at":$endAt}]}"""
        ))
        val playlist = repo.playlist(1)
        assertEquals(startAt, playlist.items.single().startAt)
        assertEquals(endAt, playlist.items.single().endAt)
        server.takeRequest()

        server.enqueue(MockResponse().setBody("""{"id":1,"name":"Lobby","orientation":"landscape","version":4,"item_count":1}"""))
        repo.savePlaylistItems(1, listOf(PlaylistEntry(7, 10, startAt, endAt)))
        val body = server.takeRequest().body.readUtf8()
        assertTrue(body, body.contains("\"start_at\":$startAt"))
        assertTrue(body, body.contains("\"end_at\":$endAt"))
    }

    @Test fun uploadsTheFileWithItsName() = runTest {
        server.enqueue(MockResponse().setResponseCode(201).setBody("""{"id":3,"filename":"Summer menu.jpg","type":"image","mime":"image/jpeg","size":5,"md5":"x","orientation":null}"""))
        val progress = mutableListOf<Float>()
        val media = repo.upload(UploadSource("Summer menu.jpg", "image/jpeg", 5) { "hello".byteInputStream() }) { progress += it }
        assertNull(media.orientation) // still checking shape
        val request = server.takeRequest()
        assertEquals("Summer%20menu.jpg", request.getHeader("X-Filename"))
        assertEquals("image/jpeg", request.getHeader("Content-Type"))
        assertEquals("hello", request.body.readUtf8())
        assertEquals(1f, progress.last())
    }

    @Test fun signInSavesTheTokenAndSignOutClearsIt() = runTest {
        server.enqueue(MockResponse().setBody("""{"token":"new","email":"a@b.c","role":"system_manager"}"""))
        repo.signInWithGoogle("google-id-token")
        assertEquals("new", saved)
        server.enqueue(MockResponse().setBody("""{"ok":true}"""))
        repo.signOut()
        assertNull(saved)
    }

    @Test fun explainsWhenTheServerCantBeReached() = runTest {
        server.shutdown()
        try {
            repo.library()
            fail("expected an error")
        } catch (e: ApiException) {
            assertTrue(e.message!!.startsWith("Can't reach the server"))
        }
    }
}
