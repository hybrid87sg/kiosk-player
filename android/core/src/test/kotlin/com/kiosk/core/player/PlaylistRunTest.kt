package com.kiosk.core.player

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PlaylistRunTest {
    @Test fun aLoopBackToTheFirstVideoIsANewVisit() {
        val cursor = PlaylistCursor(listOf(
            RunItem(1, videoFile = true),
            RunItem(2, videoFile = false),
            RunItem(3, videoFile = true),
        ))
        assertEquals(3, cursor.runs.size)
        assertTrue(cursor.current() is PlaylistRun.Videos)
        val firstVisit = cursor.visitKey()
        cursor.advance() // picture
        cursor.advance() // last video
        cursor.advance() // back to the first video
        assertEquals(0, cursor.index)
        assertTrue(cursor.current() is PlaylistRun.Videos)
        assertEquals(listOf(1L), (cursor.current() as PlaylistRun.Videos).ids)
        assertNotEquals(firstVisit, cursor.visitKey())
    }

    @Test fun theSameVideoAtBothEndsStillGetsANewVisit() {
        val cursor = PlaylistCursor(listOf(
            RunItem(1, videoFile = true),
            RunItem(2, videoFile = false),
            RunItem(1, videoFile = true),
        ))
        val first = cursor.visitKey()
        cursor.advance()
        cursor.advance()
        val lastVideo = cursor.visitKey()
        cursor.advance()
        assertNotEquals(first, cursor.visitKey())
        assertNotEquals(lastVideo, cursor.visitKey())
    }
}
