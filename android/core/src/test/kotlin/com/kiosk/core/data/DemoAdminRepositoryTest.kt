package com.kiosk.core.data

import com.kiosk.core.model.Mounting
import com.kiosk.core.model.PlayerSetup
import com.kiosk.core.model.PlaylistEntry
import com.kiosk.core.model.ScreenShape
import com.kiosk.core.network.ApiException
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class DemoAdminRepositoryTest {
    private var clock = 1_000_000L
    private val repo = DemoAdminRepository(now = { clock }, latencyMs = 0)

    @Test fun libraryIsSortedIntoShapes() = runTest {
        val shapes = repo.library().items.associate { it.filename to it.orientation }
        assertEquals(ScreenShape.LANDSCAPE, shapes["Lobby promo.mp4"])
        assertEquals(ScreenShape.PORTRAIT, shapes["Menu board portrait.jpg"])
    }

    @Test fun newFilesShowAsCheckingForAFewSeconds() = runTest {
        repo.syncLibrary() // the demo "finds" a new file in Drive
        assertNull(repo.library().items.first { it.filename == "Weekend promo.mp4" }.orientation)
        clock += 3_500
        assertEquals(ScreenShape.LANDSCAPE, repo.library().items.first { it.filename == "Weekend promo.mp4" }.orientation)
    }

    @Test fun aPlaylistInUseCantBeDeleted() = runTest {
        try {
            repo.deletePlaylist(1)
            fail("expected an error")
        } catch (e: ApiException) {
            assertTrue(e.message!!.contains("Back wall"))
        }
        val empty = repo.createPlaylist("Menu boards", ScreenShape.PORTRAIT)
        repo.deletePlaylist(empty.id)
        assertTrue(repo.playlists().none { it.id == empty.id })
    }

    @Test fun removingAFileTakesItOutOfPlaylistsAndItCanBeRestored() = runTest {
        repo.deleteMedia(1)
        assertTrue(repo.playlist(1).items.none { it.mediaId == 1L })
        val library = repo.library()
        assertTrue(library.items.none { it.id == 1L })
        assertEquals("removed", library.removed.first().removedReason)
        repo.restoreMedia(1, null, null)
        assertTrue(repo.library().items.any { it.id == 1L })
    }

    @Test fun pairingAndSavingAPlaylist() = runTest {
        val d = repo.claimDevice("k7p-29q", PlayerSetup("Front window", "Main lobby", Mounting.PORTRAIT_LEFT, 2))
        assertEquals("Reception portrait", d.playlistName)
        val saved = repo.savePlaylistItems(2, listOf(PlaylistEntry(7, 10), PlaylistEntry(6, 5)))
        assertEquals(listOf(7L, 6L), saved.items.map { it.mediaId })
        assertTrue(saved.devices.any { it.name == "Front window" })
    }
}
