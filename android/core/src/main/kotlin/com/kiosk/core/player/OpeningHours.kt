package com.kiosk.core.player

import com.kiosk.core.model.DayHours
import java.time.DayOfWeek
import java.time.LocalTime
import java.time.ZonedDateTime

/**
 * A location's working hours, as the server sends them: one entry per day
 * ("mon"…"sun"), each { open: "08:00", close: "18:00" } or null when closed.
 * No hours at all (null) means always open. A closing time earlier than the
 * opening time runs past midnight. The TV uses its own clock and time zone.
 */
object OpeningHours {
    private val KEYS = mapOf(
        DayOfWeek.MONDAY to "mon", DayOfWeek.TUESDAY to "tue", DayOfWeek.WEDNESDAY to "wed",
        DayOfWeek.THURSDAY to "thu", DayOfWeek.FRIDAY to "fri", DayOfWeek.SATURDAY to "sat", DayOfWeek.SUNDAY to "sun",
    )

    private fun entry(hours: Map<String, DayHours?>, day: DayOfWeek) = hours[KEYS.getValue(day)]

    fun isOpen(hours: Map<String, DayHours?>?, at: ZonedDateTime): Boolean {
        if (hours == null) return true
        val time = at.toLocalTime()
        entry(hours, at.dayOfWeek)?.let { today ->
            val open = LocalTime.parse(today.open)
            val close = LocalTime.parse(today.close)
            if (if (close > open) time >= open && time < close else time >= open) return true
        }
        // Yesterday's hours may run past midnight into today.
        entry(hours, at.dayOfWeek.minus(1))?.let { yesterday ->
            val open = LocalTime.parse(yesterday.open)
            val close = LocalTime.parse(yesterday.close)
            if (close < open && time < close) return true
        }
        return false
    }

    /**
     * The next moment the screen should switch (open → closed or closed → open),
     * looking up to 8 days ahead, to the minute. Null when it never changes.
     */
    fun nextChange(hours: Map<String, DayHours?>?, from: ZonedDateTime): ZonedDateTime? {
        if (hours == null) return null
        val now = isOpen(hours, from)
        // The switches can only happen at the listed opening and closing times.
        // (Starting from yesterday, whose late hours may end early today.)
        val candidates = (-1..8).flatMap { offset ->
            val day = from.toLocalDate().plusDays(offset.toLong())
            listOfNotNull(entry(hours, day.dayOfWeek)).flatMap { e ->
                val open = LocalTime.parse(e.open)
                val close = LocalTime.parse(e.close)
                // A closing time earlier than the opening time is on the next day.
                listOf(day.atTime(open), (if (close < open) day.plusDays(1) else day).atTime(close))
            }.map { it.atZone(from.zone) }
        }.filter { it.isAfter(from) }.sorted()
        return candidates.firstOrNull { isOpen(hours, it) != now }
    }
}
