package com.kiosk.core.player

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.cos
import kotlin.math.roundToInt
import kotlin.math.sin

/** Checked against the turning itself: rotate by -degrees around the centre, as the app draws. */
class TurnedScreenTest {
    private val width = 1920f
    private val height = 1080f

    /** Where a point of the seen picture (seen width × seen height) lands on the screen. */
    private fun onScreen(seenX: Float, seenY: Float, degrees: Int): Pair<Float, Float> {
        val sideways = degrees % 180 != 0
        val seenW = if (sideways) height else width
        val seenH = if (sideways) width else height
        val a = Math.toRadians(-degrees.toDouble())
        val dx = seenX - seenW / 2
        val dy = seenY - seenH / 2
        val x = width / 2 + dx * cos(a) - dy * sin(a)
        val y = height / 2 + dx * sin(a) + dy * cos(a)
        return x.toFloat() to y.toFloat()
    }

    @Test fun theSeenTopLeftCornerIsFoundOnEveryTurn() {
        for (degrees in listOf(0, 90, 180, 270)) {
            val sideways = degrees % 180 != 0
            val seenW = if (sideways) height else width
            val seenH = if (sideways) width else height
            val (cx, cy) = onScreen(20f, 20f, degrees) // 20 px into the seen top-left
            assertTrue("top-left at $degrees", TurnedScreen.inSeenTopLeft(cx, cy, width, height, degrees, 80f))
            for ((sx, sy) in listOf(seenW - 20f to 20f, 20f to seenH - 20f, seenW - 20f to seenH - 20f, seenW / 2 to seenH / 2)) {
                val (x, y) = onScreen(sx, sy, degrees)
                assertFalse("($sx,$sy) at $degrees", TurnedScreen.inSeenTopLeft(x, y, width, height, degrees, 80f))
            }
        }
    }

    @Test fun theWebPageFillsTheSeenPictureAboveTheBar() {
        for (degrees in listOf(0, 90, 180, 270)) {
            val f = TurnedScreen.webFrame(1920, 1080, degrees, bottom = 76)
            val sideways = degrees % 180 != 0
            // The seen top-left of the page, turned the way the view turns it, is the seen top-left of the screen.
            val a = Math.toRadians(f.rotation.toDouble())
            val px = f.left + f.pivotX
            val py = f.top + f.pivotY
            val x = px + (f.left - px) * cos(a) - (f.top - py) * sin(a)
            val y = py + (f.left - px) * sin(a) + (f.top - py) * cos(a)
            val (ex, ey) = onScreen(0f, 0f, degrees)
            assertEquals("x at $degrees", ex.roundToInt(), x.roundToInt())
            assertEquals("y at $degrees", ey.roundToInt(), y.roundToInt())
            assertEquals(if (sideways) 1080 else 1920, f.width)
            assertEquals((if (sideways) 1920 else 1080) - 76, f.height)
        }
    }
}
