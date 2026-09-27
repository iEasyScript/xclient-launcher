// The launcher is an Electron app, not a JVM project. This build exists only so the
// launcher sits in the same Gradle tool window as the client, the hub and the web
// marketplace — every task below is a thin wrapper around the npm script of the same
// name in package.json. Nothing here compiles anything; npm owns the real work.

val npm = if (System.getProperty("os.name").startsWith("Windows")) "npm.cmd" else "npm"

// electron-builder already owns ./build — that is its buildResources directory, and the
// installer README committed inside it ships in the NSIS and DMG targets. Gradle would
// otherwise treat the same path as its own output dir and mix generated reports into it.
layout.buildDirectory.set(layout.projectDirectory.dir(".gradle/gradle-build"))

fun npmTask(name: String, script: String, description: String, blocking: Boolean = false) =
    tasks.register<Exec>(name) {
        group = "launcher"
        this.description = description + if (blocking) " (runs until stopped)" else ""
        workingDir = projectDir
        commandLine(npm, "run", script)
        // A running Electron window is meant to be killed from the IDE, so a non-zero
        // exit from that kill is not a build failure.
        if (blocking) isIgnoreExitValue = true
    }

val install = tasks.register<Exec>("npmInstall") {
    group = "launcher"
    description = "Install node dependencies"
    workingDir = projectDir
    commandLine(npm, "install")
}

npmTask("dev", "dev", "Start the launcher with DEBUG logging", blocking = true)
npmTask("devMock", "dev:mock", "Start the launcher with mock auth and seeded demo users", blocking = true)

npmTask("test", "test", "Run the jest suite")
npmTask("testCoverage", "test:coverage", "Run jest and write coverage/")

// electron-builder can only produce a target it can run the tooling for: mac builds need
// macOS, and linux targets from Windows need Docker or WSL. The per-platform tasks are
// here for completeness; `build` picks the one this machine can actually do.
val currentPlatform = System.getProperty("os.name").let { os ->
    when {
        os.startsWith("Windows") -> "win"
        os.contains("Mac") -> "mac"
        else -> "linux"
    }
}

npmTask("distWindows", "win", "Package the NSIS installer into dist/")
npmTask("distMac", "mac", "Package the mac build into dist/ (requires macOS)")
npmTask("distLinux", "linux", "Package the AppImage and snap into dist/ (requires Linux tooling)")

tasks.register<Exec>("build") {
    group = "launcher"
    description = "Package an installer for this machine's platform into dist/"
    workingDir = projectDir
    commandLine(npm, "run", currentPlatform)
    dependsOn(install)
}
