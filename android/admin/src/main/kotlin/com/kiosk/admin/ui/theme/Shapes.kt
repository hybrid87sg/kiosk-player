package com.kiosk.admin.ui.theme

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.unit.dp

/** The few corner sizes the app uses, so cards, tiles and chips stay consistent. */
object KioskShapes {
    /** Cards, list containers, sheets' big tiles. */
    val Large = RoundedCornerShape(18.dp)
    /** Choice tiles, notices and banners inside a card. */
    val Medium = RoundedCornerShape(14.dp)
    /** Chips, thumbnails, small badges. */
    val Small = RoundedCornerShape(12.dp)
}

/** Inner padding used by every card. */
val CardPadding = 16.dp
