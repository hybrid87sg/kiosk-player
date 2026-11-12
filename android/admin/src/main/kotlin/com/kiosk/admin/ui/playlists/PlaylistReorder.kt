package com.kiosk.admin.ui.playlists

/**
 * Drag-to-reorder math for playlist rows whose heights are not all the same.
 *
 * A video row is only a title and a line of text. An image row also has the
 * duration buttons, and large fonts grow either one. The list used to treat
 * every row as 96dp tall, so a drag swapped and slid the neighbours too early
 * (or not far enough) once a row was taller than that.
 *
 * [heightsPx] is in current list order. Pass a fallback (the 96dp minimum)
 * for a row that has not been measured yet. [gapPx] is the space between rows.
 * [dragOffsetPx] is positive when the held row moves down.
 */

/** Index the held row should drop at. It swaps once its centre passes a neighbour's centre. */
internal fun reorderTargetIndex(
    fromIndex: Int,
    dragOffsetPx: Float,
    heightsPx: List<Float>,
    gapPx: Float,
): Int {
    val last = heightsPx.lastIndex
    if (fromIndex !in 0..last) return fromIndex.coerceIn(0, last.coerceAtLeast(0))
    val self = heightsPx[fromIndex]
    if (dragOffsetPx > 0f) {
        var index = fromIndex
        var distance = 0f
        while (index < last) {
            val next = heightsPx[index + 1]
            val centersApart = distance + (self + next) / 2f + gapPx
            if (dragOffsetPx < centersApart) break
            distance += next + gapPx
            index++
        }
        return index
    }
    if (dragOffsetPx < 0f) {
        var index = fromIndex
        var distance = 0f
        val up = -dragOffsetPx
        while (index > 0) {
            val prev = heightsPx[index - 1]
            val centersApart = distance + (self + prev) / 2f + gapPx
            if (up < centersApart) break
            distance += prev + gapPx
            index--
        }
        return index
    }
    return fromIndex
}

/**
 * Smallest drag offset that lands on [toIndex].
 * The gesture limit has to allow at least this far, or a short neighbour
 * (whose centre sits beyond the slot the held row will rest in) can never be passed.
 */
internal fun reorderReachOffset(
    fromIndex: Int,
    toIndex: Int,
    heightsPx: List<Float>,
    gapPx: Float,
): Float {
    if (fromIndex !in heightsPx.indices || toIndex !in heightsPx.indices || toIndex == fromIndex) return 0f
    val self = heightsPx[fromIndex]
    return if (toIndex > fromIndex) {
        var distance = 0f
        for (i in (fromIndex + 1) until toIndex) distance += heightsPx[i] + gapPx
        distance + (self + heightsPx[toIndex]) / 2f + gapPx
    } else {
        var distance = 0f
        for (i in (toIndex + 1) until fromIndex) distance += heightsPx[i] + gapPx
        -(distance + (self + heightsPx[toIndex]) / 2f + gapPx)
    }
}

/**
 * How far a row that is not being dragged should slide.
 * Every displaced row moves by the held row's own height plus the gap, which
 * is the hole that row leaves behind. Taller and shorter neighbours share that
 * same shift; their own heights decide when the swap happens, not how far they jump.
 */
internal fun reorderShiftPx(
    index: Int,
    dragIndex: Int?,
    target: Int?,
    draggedHeightPx: Float,
    gapPx: Float,
): Float {
    if (dragIndex == null || target == null || index == dragIndex) return 0f
    val step = draggedHeightPx + gapPx
    return when {
        dragIndex < target && index in (dragIndex + 1)..target -> -step
        target < dragIndex && index in target until dragIndex -> step
        else -> 0f
    }
}
