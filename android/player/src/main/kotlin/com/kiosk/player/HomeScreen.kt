package com.kiosk.player

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.provider.Settings

/**
 * Optional, per TV: the player as the TV box's home screen (its "launcher").
 *
 * Android always reopens the home screen app, whatever closed it, even a
 * force stop by a cleaner app, which nothing else survives. The Home button
 * then also leads back to the player; staff use "Leave for 15 minutes" and
 * "Open TV settings" to get to the box's settings.
 *
 * It's a second entrance to the same screen (an "activity alias" in the
 * manifest), switched off until someone turns it on here.
 */
object HomeScreen {
    private fun alias(context: Context) = ComponentName(context, "com.kiosk.player.HomeScreen")

    /** The player offers itself as a home screen app. */
    fun isOffered(context: Context): Boolean =
        context.packageManager.getComponentEnabledSetting(alias(context)) == PackageManager.COMPONENT_ENABLED_STATE_ENABLED

    /** The player is the home screen Android opens. */
    fun isDefault(context: Context): Boolean {
        val home = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME)
        val chosen = context.packageManager.resolveActivity(home, PackageManager.MATCH_DEFAULT_ONLY)
        return chosen?.activityInfo?.packageName == context.packageName
    }

    /**
     * Offers the player as a home screen and opens Android's screen to choose
     * it. Returns false when this TV shows no such screen: then use [ADB_COMMAND].
     */
    fun offer(activity: Activity): Boolean {
        setOffered(activity, true)
        KeepInFront.pauseFor(activity, 3) // don't jump back while Android's screen is open
        val choices = listOf(
            Intent(Settings.ACTION_HOME_SETTINGS),
            // With two home apps and no default, Android asks which one to use.
            Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
        for (intent in choices) {
            try {
                activity.startActivity(intent)
                return true
            } catch (e: ActivityNotFoundException) {
                // try the next one
            }
        }
        return false
    }

    /** Stops offering: Android goes back to the TV's usual home screen. */
    fun stop(context: Context) = setOffered(context, false)

    private fun setOffered(context: Context, on: Boolean) {
        context.packageManager.setComponentEnabledSetting(
            alias(context),
            if (on) PackageManager.COMPONENT_ENABLED_STATE_ENABLED else PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
            PackageManager.DONT_KILL_APP,
        )
    }

    const val ADB_COMMAND = "adb shell cmd package set-home-activity com.kiosk.player/.HomeScreen"
}
