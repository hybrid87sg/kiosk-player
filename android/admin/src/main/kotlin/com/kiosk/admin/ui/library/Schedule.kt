package com.kiosk.admin.ui.library

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SelectableDates
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter

// A file's dates. People pick the first and last day it shows (both optional),
// in the phone's time zone, like on the web page: it starts at the beginning
// of the first day, and leaves Kiosk at the start of the day after the last.

private val DAY = DateTimeFormatter.ofPattern("d MMM")

fun startOf(firstDay: LocalDate): Long = firstDay.atStartOfDay(ZoneId.systemDefault()).toInstant().toEpochMilli()
fun expiryAfter(lastDay: LocalDate): Long = startOf(lastDay.plusDays(1))
fun firstDayOf(startsAt: Long): LocalDate = Instant.ofEpochMilli(startsAt).atZone(ZoneId.systemDefault()).toLocalDate()
fun lastDayOf(expiresAt: Long): LocalDate = Instant.ofEpochMilli(expiresAt - 1).atZone(ZoneId.systemDefault()).toLocalDate()

fun startsOn(startsAt: Long): String = "Starts " + firstDayOf(startsAt).format(DAY)
fun showsUntil(expiresAt: Long): String = "Shows until " + lastDayOf(expiresAt).format(DAY)

/** True when 3 days or less are left, so the app can warn. */
fun expiresSoon(expiresAt: Long): Boolean = expiresAt - System.currentTimeMillis() <= 3 * 86_400_000L

/**
 * Choose a file's first and last day, each optional. [onSave] gets the start
 * and expiry times (null = no limit).
 */
@Composable
fun ScheduleDialog(
    title: String,
    startsAt: Long?,
    expiresAt: Long?,
    confirmLabel: String,
    onSave: (startsAt: Long?, expiresAt: Long?) -> Unit,
    onDismiss: () -> Unit,
) {
    var first by remember { mutableStateOf(startsAt?.let(::firstDayOf)) }
    var last by remember { mutableStateOf(expiresAt?.let(::lastDayOf)) }
    var picking by remember { mutableStateOf<String?>(null) } // "first" or "last"
    val valid = first == null || last == null || !last!!.isBefore(first)

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                DateRow("Show from", first, onChange = { picking = "first" }, onClear = { first = null })
                DateRow("Show until", last, onChange = { picking = "last" }, onClear = { last = null })
                Text(
                    if (valid) "Before the first day it waits in the library. After the last day it leaves Kiosk and every screen. Google Drive keeps it."
                    else "The last day must be on or after the first day.",
                    style = MaterialTheme.typography.bodySmall,
                    color = if (valid) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.error,
                )
            }
        },
        confirmButton = {
            TextButton(onClick = { onSave(first?.let(::startOf), last?.let(::expiryAfter)) }, enabled = valid) { Text(confirmLabel) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )

    picking?.let { which ->
        DayPicker(
            initial = if (which == "first") first else last,
            earliest = if (which == "last") maxOf(LocalDate.now(), first ?: LocalDate.now()) else null,
            onPicked = { day -> if (which == "first") first = day else last = day; picking = null },
            onDismiss = { picking = null },
        )
    }
}

@Composable
private fun DateRow(label: String, day: LocalDate?, onChange: () -> Unit, onClear: () -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(label, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
            Text(day?.format(DateTimeFormatter.ofPattern("EEE d MMM yyyy")) ?: "No limit", style = MaterialTheme.typography.bodyMedium)
        }
        TextButton(onClick = onChange) { Text(if (day == null) "Set" else "Change") }
        if (day != null) TextButton(onClick = onClear) { Text("Clear") }
    }
}

/** The calendar. It works in UTC midnights, converted to and from the phone's own dates. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DayPicker(initial: LocalDate?, earliest: LocalDate?, onPicked: (LocalDate) -> Unit, onDismiss: () -> Unit) {
    val state = rememberDatePickerState(
        initialSelectedDateMillis = initial?.atStartOfDay(ZoneOffset.UTC)?.toInstant()?.toEpochMilli(),
        selectableDates = object : SelectableDates {
            override fun isSelectableDate(utcTimeMillis: Long) =
                earliest == null || !Instant.ofEpochMilli(utcTimeMillis).atZone(ZoneOffset.UTC).toLocalDate().isBefore(earliest)
        },
    )
    DatePickerDialog(
        onDismissRequest = onDismiss,
        confirmButton = {
            TextButton(
                onClick = { state.selectedDateMillis?.let { onPicked(Instant.ofEpochMilli(it).atZone(ZoneOffset.UTC).toLocalDate()) } },
                enabled = state.selectedDateMillis != null,
            ) { Text("OK") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    ) {
        DatePicker(state = state, modifier = Modifier.padding(top = 8.dp))
    }
}
