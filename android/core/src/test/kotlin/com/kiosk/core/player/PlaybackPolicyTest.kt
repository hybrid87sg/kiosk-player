package com.kiosk.core.player

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PlaybackPolicyTest {
    private val modes = listOf(
        RefreshMode(1, 1920, 1080, 60f),
        RefreshMode(2, 1920, 1080, 50f),
        RefreshMode(3, 1920, 1080, 24f),
        RefreshMode(4, 3840, 2160, 60f),
    )

    @Test fun matchesAnIntegerMultipleOfTheFrameRate() {
        assertEquals(1, chooseDisplayMode(modes, 1920, 1080, 30f))
        assertEquals(3, chooseDisplayMode(modes, 1920, 1080, 23.976f))
        assertEquals(4, chooseDisplayMode(modes, 3840, 2160, 60f))
    }

    @Test fun leavesThePanelAloneWhenNothingIsClose() {
        // 60Hz is not a whole multiple of 24fps, and this list has no 24Hz mode.
        assertNull(chooseDisplayMode(listOf(RefreshMode(1, 1920, 1080, 60f)), 1920, 1080, 24f))
        assertNull(chooseDisplayMode(modes, 1280, 720, 30f))
        assertNull(chooseDisplayMode(modes, 1920, 1080, 0f))
    }

    @Test fun waitsLongerEachTimeAVideoFails() {
        assertEquals(5_000L, playbackRetryDelayMs(1))
        assertEquals(10_000L, playbackRetryDelayMs(2))
        assertEquals(20_000L, playbackRetryDelayMs(3))
        assertEquals(60_000L, playbackRetryDelayMs(8))
    }

    @Test fun readsAndroidH264Levels() {
        assertEquals(41, avcLevelNumber(0x1000))
        assertEquals(31, avcLevelNumber(0x200))
        assertEquals(0, avcLevelNumber(0))
    }

    @Test fun keepsHeadroomOnTheDisk() {
        val headroom = DOWNLOAD_HEADROOM_BYTES
        assertTrue(enoughFreeSpace(headroom + 300_000, 300_000))
        assertFalse(enoughFreeSpace(300_000, 300_000))
        assertTrue(enoughFreeSpace(0, 0))
    }

    @Test fun warnsOnlyForVideosAbove1080p() {
        assertNull(heavyVideoWarning(false, 3840, 2160))
        assertNull(heavyVideoWarning(true, 1920, 1080))
        assertTrue(heavyVideoWarning(true, 3840, 2160)!!.contains("3840×2160"))
        assertTrue(heavyVideoWarning(true, 1080, 1920) == null)
        assertTrue(heavyVideoWarning(true, 2160, 3840)!!.contains("2160×3840"))
    }
}