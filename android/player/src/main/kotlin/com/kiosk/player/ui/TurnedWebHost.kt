package com.kiosk.player.ui

import android.content.Context
import android.view.View
import android.widget.FrameLayout
import com.kiosk.core.player.TurnedScreen

/**
 * Holds the web page on a screen the app turns itself (0.12.1). Compose's turning
 * (graphicsLayer) only moves Android views' taps, it doesn't turn them, so a web page
 * inside it got every tap at a sideways position. Here Android's own view rotation turns
 * the page instead, and Android turns each tap with it.
 */
class TurnedWebHost(context: Context) : FrameLayout(context) {
    /** How far the app turns its picture (Mounting.rotationDegrees). */
    var degrees: Int = 0
        set(value) { if (field != value) { field = value; requestLayout() } }

    /** Pixels kept free at the bottom of the picture as people see it (the bar, the keyboard). */
    var bottomPx: Int = 0
        set(value) { if (field != value) { field = value; requestLayout() } }

    private fun frame(width: Int, height: Int) = TurnedScreen.webFrame(width, height, degrees, bottomPx)

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val width = MeasureSpec.getSize(widthMeasureSpec)
        val height = MeasureSpec.getSize(heightMeasureSpec)
        setMeasuredDimension(width, height)
        val f = frame(width, height)
        for (i in 0 until childCount) {
            getChildAt(i).measure(
                MeasureSpec.makeMeasureSpec(f.width, MeasureSpec.EXACTLY),
                MeasureSpec.makeMeasureSpec(f.height, MeasureSpec.EXACTLY),
            )
        }
    }

    override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
        val f = frame(right - left, bottom - top)
        for (i in 0 until childCount) {
            val child: View = getChildAt(i)
            child.layout(f.left, f.top, f.left + f.width, f.top + f.height)
            child.pivotX = f.pivotX
            child.pivotY = f.pivotY
            child.rotation = f.rotation
        }
    }
}
