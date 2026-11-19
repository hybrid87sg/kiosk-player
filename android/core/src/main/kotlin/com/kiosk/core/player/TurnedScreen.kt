package com.kiosk.core.player

/**
 * Where things are on a screen that Kiosk Player turns itself (0.12.1).
 *
 * A TV box sends a landscape picture; on a screen mounted on its side, the app turns
 * its picture by [degrees] (Mounting.rotationDegrees: 0, 90, 180 or 270), exactly as
 * Compose's graphicsLayer(rotationZ = -degrees) does around the screen's centre.
 * Android itself doesn't know, so touches arrive in the screen's own, unturned pixels.
 */
object TurnedScreen {
    private fun norm(degrees: Int) = ((degrees % 360) + 360) % 360

    /**
     * Is a touch at ([x], [y]) in the screen's own pixels inside the top-left corner of
     * the picture *as people see it*, [corner] pixels each way?
     */
    fun inSeenTopLeft(x: Float, y: Float, width: Float, height: Float, degrees: Int, corner: Float): Boolean =
        when (norm(degrees)) {
            90 -> x <= corner && y >= height - corner
            180 -> x >= width - corner && y >= height - corner
            270 -> x >= width - corner && y <= corner
            else -> x <= corner && y <= corner
        }

    /** Where to put a web page, in the screen's own pixels, before turning it by [rotation] around [pivotX], [pivotY]. */
    data class Frame(val left: Int, val top: Int, val width: Int, val height: Int, val pivotX: Float, val pivotY: Float, val rotation: Float)

    /**
     * The web page's place on a [width] × [height] screen turned by [degrees]: the whole
     * picture as people see it, less [bottom] pixels at its (seen) bottom for the bar.
     * Turned by Android's own view rotation, touches on the page then land where they look.
     */
    fun webFrame(width: Int, height: Int, degrees: Int, bottom: Int): Frame {
        val d = norm(degrees)
        val sideways = d == 90 || d == 270
        val w = if (sideways) height else width
        val h = if (sideways) width else height
        return Frame(
            left = (width - w) / 2,
            top = (height - h) / 2,
            width = w,
            height = (h - bottom).coerceAtLeast(0),
            pivotX = w / 2f,
            pivotY = h / 2f,
            rotation = -d.toFloat(),
        )
    }
}
