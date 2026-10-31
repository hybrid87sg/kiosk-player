package com.kiosk.admin.ui.library

import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.SelectableDates
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter

// Expiry dates. People pick the last day a file shows; it leaves Kiosk at the
// start of the next day, in the phone's time zone (like on the web page).

/** The expiry time for a chosen last day: midnight at the end of it. */
fun expiryAfter(lastDay: LocalDate): Long =
    lastDay.plusDays(1).atStartOfDay(ZoneId.systemDefault()).toInstant().toEpochMilli()

/** The last day a file shows, from its expiry time. */
fun lastDayOf(expiresAt: Long): LocalDate =
    Instant.ofEpochMilli(expiresAt - 1).atZone(ZoneId.systemDefault()).toLocalDate()

/** "Shows until 24 Dec". */
fun showsUntil(expiresAt: Long): String =
    "Shows until " + lastDayOf(expiresAt).format(DateTimeFormatter.ofPattern("d MMM"))

/** True when 3 days or less are left, so the app can warn. */
fun expiresSoon(expiresAt: Long): Boolean = expiresAt - System.currentTimeMillis() <= 3 * 86_400_000L

/**
 * A calendar to choose a file's last day, with "No expiry" as the other choice.
 * [onPicked] gets the expiry time, or null for "no expiry".
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ExpiryPicker(
    current: Long?,
    confirmLabel: String,
    onPicked: (Long?) -> Unit,
    onDismiss: () -> Unit,
) {
    val today = LocalDate.now()
    // The calendar works in UTC midnights; convert to and from the phone's own dates.
    val state = rememberDatePickerState(
        initialSelectedDateMillis = current?.let { lastDayOf(it).atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli() },
        selectableDates = object : SelectableDates {
            override fun isSelectableDate(utcTimeMillis: Long) =
                !Instant.ofEpochMilli(utcTimeMillis).atZone(ZoneOffset.UTC).toLocalDate().isBefore(today)
            override fun isSelectableYear(year: Int) = year >= today.year
        },
    )
    DatePickerDialog(
        onDismissRequest = onDismiss,
        confirmButton = {
            TextButton(
                onClick = {
                    state.selectedDateMillis?.let { ms ->
                        onPicked(expiryAfter(Instant.ofEpochMilli(ms).atZone(ZoneOffset.UTC).toLocalDate()))
                    }
                },
                enabled = state.selectedDateMillis != null,
            ) { Text(confirmLabel) }
        },
        dismissButton = {
            Row {
                TextButton(onClick = { onPicked(null) }) { Text("No expiry") }
                TextButton(onClick = onDismiss) { Text("Cancel") }
            }
        },
    ) {
        DatePicker(
            state = state,
            title = { Text("Show until (the last day it plays)", modifier = Modifier.padding(start = 24.dp, end = 12.dp, top = 16.dp)) },
        )
    }
}
