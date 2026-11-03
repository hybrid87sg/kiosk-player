package com.kiosk.core.player

/** One thing in a playlist, reduced to what the player uses to group runs. */
data class RunItem(val id: Long, val videoFile: Boolean)

sealed interface PlaylistRun {
    data class Videos(val ids: List<Long>) : PlaylistRun
    data class Picture(val id: Long) : PlaylistRun
}

/** Consecutive videos stay together. A picture breaks the run. */
fun segmentRuns(items: List<RunItem>): List<PlaylistRun> {
    val out = mutableListOf<PlaylistRun>()
    val videos = mutableListOf<Long>()
    fun flush() {
        if (videos.isNotEmpty()) {
            out += PlaylistRun.Videos(videos.toList())
            videos.clear()
        }
    }
    for (item in items) {
        if (item.videoFile) videos += item.id
        else {
            flush()
            out += PlaylistRun.Picture(item.id)
        }
    }
    flush()
    return out
}

/**
 * Steps through [runs]. [visitKey] changes on every visit, including when a
 * loop returns to a video run whose files are the same as last time. The
 * player uses this so a finished video player is not reused for the next lap.
 */
class PlaylistCursor(items: List<RunItem>) {
    val runs: List<PlaylistRun> = segmentRuns(items)
    var index: Int = 0
        private set
    var plays: Int = 0
        private set

    fun current(): PlaylistRun = runs[index % runs.size]

    fun advance() {
        if (runs.isEmpty()) return
        index = (index + 1) % runs.size
        plays += 1
    }

    fun visitKey(): String = playlistVisitKey(index, plays)
}

/** Changes on every visit, so a finished video player is not reused on the next lap. */
fun playlistVisitKey(index: Int, plays: Int): String = "$index:$plays"
