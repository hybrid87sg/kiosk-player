package com.kiosk.player

import android.view.MotionEvent
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow

/**
 * Touches and typing anywhere on the screen (0.12.0), seen by [MainActivity] before
 * anything else gets them, so a Web Kiosk counts a customer as "still there" wherever
 * they touch: the web page, a form inside an embedded frame, the bar, the keyboard.
 * (The Windows app learned this the hard way: a page's own helper never sees frames.)
 *
 * Also counts staff taps in the top-left corner: 5 within 3 seconds opens the staff PIN.
 */
object KioskInput {
    /** When someone last touched or typed (System.currentTimeMillis). */
    @Volatile var lastActivity: Long = System.currentTimeMillis()
        private set

    private val taps = ArrayDeque<Long>()
    private val _cornerTaps = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
    /** Fires after 5 quick taps in the top-left corner. */
    val cornerTaps: SharedFlow<Unit> = _cornerTaps

    /** Someone is using the screen (also called for typing on the on-screen keyboard). */
    fun active() {
        lastActivity = System.currentTimeMillis()
    }

    /** Every touch on the screen. [density] turns the 80 dp corner into pixels. */
    fun touched(event: MotionEvent, density: Float) {
        active()
        if (event.actionMasked != MotionEvent.ACTION_DOWN) return
        val corner = CORNER_DP * density
        if (event.x > corner || event.y > corner) return
        val now = System.currentTimeMillis()
        synchronized(taps) {
            taps.addLast(now)
            while (taps.isNotEmpty() && now - taps.first() > TAPS_WITHIN_MS) taps.removeFirst()
            if (taps.size >= TAPS_NEEDED) {
                taps.clear()
                _cornerTaps.tryEmit(Unit)
            }
        }
    }

    /** True for a touch in the staff corner (it doesn't also open the web page). */
    fun inCorner(x: Float, y: Float, density: Float): Boolean = x <= CORNER_DP * density && y <= CORNER_DP * density

    private const val CORNER_DP = 80f
    private const val TAPS_NEEDED = 5
    private const val TAPS_WITHIN_MS = 3_000L
}
