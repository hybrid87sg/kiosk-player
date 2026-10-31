package com.kiosk.admin.ui.playlists

import kotlin.math.roundToInt
import org.junit.Assert.assertEquals
import org.junit.Test

class PlaylistReorderTest {
    private val gap = 16f

    @Test fun staysPutUntilTheNextCentreIsPassed() {
        val heights = listOf(400f, 200f, 160f)
        val fixedStep = 96f + 8f
        // Far enough to fool a fixed 96dp step, not far enough to pass a 200px neighbour.
        assertEquals(1, (150f / fixedStep).roundToInt())
        assertEquals(0, reorderTargetIndex(0, 150f, heights, gap))

        val threshold = (400f + 200f) / 2f + gap
        assertEquals(0, reorderTargetIndex(0, threshold - 0.5f, heights, gap))
        assertEquals(1, reorderTargetIndex(0, threshold, heights, gap))
    }

    @Test fun crossesSeveralRowsByTheirOwnHeights() {
        val heights = listOf(100f, 100f, 100f)
        val one = (100f + 100f) / 2f + 8f
        assertEquals(0, reorderTargetIndex(0, one - 0.5f, heights, 8f))
        assertEquals(1, reorderTargetIndex(0, one, heights, 8f))
        assertEquals(1, reorderTargetIndex(0, one * 2f - 0.5f, heights, 8f))
        assertEquals(2, reorderTargetIndex(0, one * 2f, heights, 8f))
    }

    @Test fun draggingUpUsesTheSameCentreRule() {
        val heights = listOf(160f, 200f, 400f)
        val reach = reorderReachOffset(2, 0, heights, gap)
        assertEquals(0, reorderTargetIndex(2, reach, heights, gap))
        assertEquals(1, reorderTargetIndex(2, reach + 1f, heights, gap))
        assertEquals(2, reorderTargetIndex(2, 0f, heights, gap))
    }

    @Test fun displacedRowsShiftByTheHeldRowNotByAFixedStep() {
        val dragged = 400f
        assertEquals(-(dragged + gap), reorderShiftPx(1, dragIndex = 0, target = 2, draggedHeightPx = dragged, gapPx = gap))
        assertEquals(-(dragged + gap), reorderShiftPx(2, dragIndex = 0, target = 2, draggedHeightPx = dragged, gapPx = gap))
        assertEquals(0f, reorderShiftPx(0, dragIndex = 0, target = 2, draggedHeightPx = dragged, gapPx = gap))
        assertEquals(0f, reorderShiftPx(3, dragIndex = 0, target = 2, draggedHeightPx = dragged, gapPx = gap))
        assertEquals(dragged + gap, reorderShiftPx(0, dragIndex = 2, target = 0, draggedHeightPx = dragged, gapPx = gap))
        assertEquals(dragged + gap, reorderShiftPx(1, dragIndex = 2, target = 0, draggedHeightPx = dragged, gapPx = gap))
    }

    @Test fun reachOffsetIsExactlyTheSwapPoint() {
        val heights = listOf(180f, 90f, 240f)
        val down = reorderReachOffset(0, 2, heights, gap)
        assertEquals(2, reorderTargetIndex(0, down, heights, gap))
        assertEquals(1, reorderTargetIndex(0, down - 0.5f, heights, gap))
        assertEquals(0f, reorderReachOffset(1, 1, heights, gap), 0f)
    }

    @Test fun emptyOrUnknownIndexDoesNotCrash() {
        assertEquals(0, reorderTargetIndex(3, 40f, emptyList(), gap))
        assertEquals(0, reorderTargetIndex(5, 40f, listOf(10f), gap))
        assertEquals(0f, reorderShiftPx(0, dragIndex = null, target = null, draggedHeightPx = 10f, gapPx = gap), 0f)
    }
}
