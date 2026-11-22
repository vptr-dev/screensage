<p align="center"><img src="assets/icon.png" width="112" alt="" /></p>

# ScreenSage

A small glass window for Windows that answers whatever question is on your
screen. Fit the frame around it, press **Answer**, done.

## Features

- **Answer on demand.** Nothing is captured or sent until you press Answer
  (or `Ctrl + Shift + Space`).
- **Clear answers.** The answer comes first, big, with proper maths
  (fractions, roots, powers). The working out folds away underneath.
- **Explain mode.** A short "how to get there" so you can reach the same
  answer yourself.
- **Fill in.** Clicks, types or drags the answer into the question inside the
  frame (never presses submit). Esc stops it.
- **Steps.** Line up blocks that run after each answer: Fill in, Click, Click
  by name, Type, Press keys, Wait, Scroll, Copy answer, Read aloud, Mouse
  back, Check result and Keep going. Drag them into order in
  **Settings → Steps**.
- **Check result.** Reads whether the quiz marked the answer right (its words,
  ticks and crosses, or green and red). If it was wrong, it works out a new
  answer with what the quiz said and tries again.
- **Keep going.** Answers the next question too, as many times as you choose,
  with an optional wait (seconds or minutes) between questions. Stops on Esc
  or when the page stops changing.
- **Presets.** Start from a ready-made set (Answer them all; Fill in, check,
  next; Fill in and submit; Type it and press Enter…) or save your own blocks
  under a name, one for each site you use.
- **Clicks that follow the button.** Point at a button once (say Check answer
  or Next) and it is found again on every question, even when it moves: by its
  name, by reading the words on screen, or by how it looks. A click can also
  wait for the page to change before the next block runs.
- **Wrong answer?** One button solves it again from scratch with fresh
  thinking, and always comes back with a different answer.
- **No going in circles.** If the thinking keeps doubling back, it starts
  over with a shorter, more decisive think.
- **Glass frame.** Drag it by its toolbar, pull any edge or corner, or draw a
  new area. It can shade everything outside it.
- **Recents.** Past answers with their captures; click a capture to see it
  full size.
- **Timer.** A tiny glass countdown (or stopwatch) that floats on top.
- **Everywhere.** Stays on every virtual desktop and works across screens.
- **Local or cloud.** Free and local with Ollama or LM Studio, or your own key
  for Claude, OpenAI, Gemini or OpenRouter (stored encrypted on your PC).
  Download local models right from **Settings → Model**.

## Install

Download the installer from [Releases](../../releases) and run it. It isn't
code-signed, so Windows SmartScreen may ask first: **More info → Run anyway**.

To update, open **Settings → General → Check for updates**. Your settings and
recents are kept.

Uninstalling asks whether to delete your local data too. You can also clear
it any time in **Settings → Storage**.

## Run from source

```bash
npm install
npm start
```

Build the installer with `npm run dist` (output in `dist/`). If the build fails
with a "could not open file" error, the folder path is too long: move the
project somewhere shorter, such as `C:\dev\screensage`.

## Privacy

Only the area inside the frame is captured, and only when you press Answer.
With Ollama or LM Studio nothing leaves your computer. With a cloud provider
the capture goes to that provider. Recents and settings stay on this PC.
