package com.kiosk.core.player

import com.kiosk.core.model.DayHours
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.ZoneId
import java.time.ZonedDateTime

class OpeningHoursTest {
    private val zone = ZoneId.of("Asia/Singapore")
    private val day = DayHours("08:00", "18:00")
    // Mon–Thu 08:00–18:00, Friday 18:00 until 02:00 Saturday, weekend closed.
    private val hours = mapOf("mon" to day, "tue" to day, "wed" to day, "thu" to day, "fri" to DayHours("18:00", "02:00"), "sat" to null, "sun" to null)

    private fun at(text: String) = ZonedDateTime.of(java.time.LocalDateTime.parse(text), zone) // 2026-11-02 is a Monday

    @Test fun alwaysOpenWithoutHours() {
        assertTrue(OpeningHours.isOpen(null, at("2026-11-02T03:00")))
        assertNull(OpeningHours.nextChange(null, at("2026-11-02T03:00")))
    }

    @Test fun openAndClosedTimes() {
        assertFalse(OpeningHours.isOpen(hours, at("2026-11-02T07:59")))
        assertTrue(OpeningHours.isOpen(hours, at("2026-11-02T08:00")))
        assertFalse(OpeningHours.isOpen(hours, at("2026-11-02T18:00")))
        assertFalse(OpeningHours.isOpen(hours, at("2026-11-08T12:00"))) // Sunday
    }

    @Test fun lateNightRunsPastMidnight() {
        assertTrue(OpeningHours.isOpen(hours, at("2026-11-06T23:00"))) // Friday night
        assertTrue(OpeningHours.isOpen(hours, at("2026-11-07T01:30"))) // early Saturday
        assertFalse(OpeningHours.isOpen(hours, at("2026-11-07T02:00")))
    }

    @Test fun nextChangeIsTheNextOpeningOrClosing() {
        assertEquals(at("2026-11-02T08:00"), OpeningHours.nextChange(hours, at("2026-11-02T06:00")))
        assertEquals(at("2026-11-02T18:00"), OpeningHours.nextChange(hours, at("2026-11-02T09:00")))
        // Thursday evening: next opening is Friday 18:00.
        assertEquals(at("2026-11-06T18:00"), OpeningHours.nextChange(hours, at("2026-11-05T19:00")))
        // Saturday 01:00: closes at 02:00; then nothing until Monday 08:00.
        assertEquals(at("2026-11-07T02:00"), OpeningHours.nextChange(hours, at("2026-11-07T01:00")))
        assertEquals(at("2026-11-09T08:00"), OpeningHours.nextChange(hours, at("2026-11-07T03:00")))
    }
}
