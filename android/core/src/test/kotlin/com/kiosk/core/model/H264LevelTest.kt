package com.kiosk.core.model

import org.junit.Assert.assertEquals
import org.junit.Test

class H264LevelTest {
    @Test
    fun writesLevelsTheWayPeopleDo() {
        assertEquals("4.1", formatH264Level(41))
        assertEquals("5.0", formatH264Level(50))
        assertEquals("1b", formatH264Level(9))
    }
}
