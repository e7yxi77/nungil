# 눈길 Nungil

Browse the web with your eyes and voice. A Chrome extension for people who can't easily use a mouse.

Look at a button and it highlights. Keep looking, or say "클릭", and it's clicked. No special hardware, just a webcam and a mic.

## Install

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and choose the `extension` folder.
3. Click the extension's toolbar icon, then **시선 교정 / Calibrate**.
4. Allow the camera and mic. If macOS asks, allow Chrome in System Settings too.
5. Look at each of the 9 dots.
6. Reload any tabs that were open before you installed it, if the overlay doesn't appear.

## Voice commands

| Korean | English | Action |
| --- | --- | --- |
| 클릭 | click | Press the highlighted item |
| 번호, then 3번 | numbers, then three | Label items with numbers and pick one |
| 아래로 / 위로 | down / up | Scroll |
| 맨 위로 / 맨 아래로 | top / bottom | Jump to the end |
| 뒤로 / 앞으로 | back / forward | Change page |
| 새로고침 | reload | Reload the page |
| 입력 안녕하세요 | type hello | Enter text in the focused field |
| 시선 맞춤 | recenter | Fix the cursor when it drifts |
| 멈춰 / 다시 시작 | pause / resume | Stop and restart control |
| 클릭 5 | click 5 | Pick a labelled item directly |
| 읽어줘 / 단순 보기 | read / simplify | Read aloud, or show text only |
| 취소 | cancel | Close numbers and help |
| 도움말 | help | Show this list on the page |

**Dwell click** is on by default: the item you look at is highlighted, and holding your gaze on it clicks it: the countdown starts after 0.5 seconds and runs for 1.5 seconds. There's no moving pointer. It never clicks buttons that look risky, such as 결제 or 삭제. Those turn red and need a spoken "클릭". You can change the time or turn it off in the popup.

Webcam gaze can't separate items packed together, like a navbar. Only an item you can actually press is ever highlighted, and the highlight holds still until your gaze has clearly moved off it. When you rest your gaze on a group like that, or say "클릭" there, its items open large in the middle of the screen. Look at one (0.5 seconds, then a 1-second countdown), or say its number. Each choice also teaches the tracker how far off it was.

## Other hands-free controls

Each one can be turned on or off in the popup.

| Control | Action | Default |
| --- | --- | --- |
| Open mouth (hold 0.9s) | Scroll down, repeating while your mouth stays open | On |
| Pop sound / hum | Click / scroll down | Off, and it replaces voice commands while on |
| Head-only cursor | Ignore the eyes and steer only by turning your head, after its own calibration. For dim light | Off |

The default cursor follows both your eyes and your head, because calibration has you look at dots both ways. Recalibrate after updating from an older version.

## Staying accurate

The cursor is worked out from where your head is and which way you're looking, so it should hold up when you shift in your seat. If it still drifts:

- Say "시선 맞춤" (recenter), or use the popup button, then look at the centre dot for 2 seconds.
- Saying "클릭" also corrects it a little: if the item you click was slightly off from your gaze, it learns the difference.
- Recalibrate fully if you move to a different seat or the lighting changes.

## Reading

Say "읽어줘" (read) to read the article aloud with each word highlighted, or "단순 보기" (simplify) for a large-text view with no speech. Say "그만" or "닫기" to close. Word highlighting depends on the voice installed; some voices highlight nothing but still read.

## AI features

Sign in to ChatGPT from the popup. These use your own ChatGPT account, with no API key.

| Say | What happens |
| --- | --- |
| 로그인 버튼 눌러줘 / click the login button | AI finds the item on screen and presses it. Risky or ambiguous matches get number labels to confirm instead |
| 뉴스 찾아줘 / find news | AI labels matching items without pressing anything |
| 단순 보기 / simplify | Shows the article at once, then swaps in easy wording. Without sign-in, the plain article stays |
| 요약해줘 / summarize | Shows a short summary and reads it aloud |

| 지메일 들어가서 메일 작성해줘 / go to gmail and write an email | AI carries out the whole task, moving between pages, pressing and typing, up to 12 steps |

While the AI works, your voice can stop it: say 취소 or 멈춰. It stops by itself and asks you before pressing anything that looks hard to undo, such as send, pay or delete: say 1번 to confirm. It won't type into password or payment fields, and it leaves sign-in to you. Turn it off in the popup with "AI tasks". Each step sends your request, the page's address without its query string, and the labels of on-screen items to your ChatGPT account. On a mailbox, those labels include subject lines. A page could also try to trick the AI through its text, which is why the checks above live in the extension, not in the AI.

Free-form requests must be phrased as a request: ending in 눌러줘, 열어줘, 찾아줘 or another 해줘 form, or starting with click, press, open, find, go to, search for, compose or write. Other conversation is not sent to the AI, but something near the mic phrased that way could be, so turn off AI tasks if you're around other voices. Only items currently on screen can be found.

This signs in through the OpenAI Codex CLI's OAuth client and calls the endpoint that client uses. OpenAI publishes that interface for its own tools, not third parties, so it's a terms-of-service gray area and may stop working. Fine for a hackathon demo; replace it with an official API before a public release or Chrome Web Store submission.

## Privacy

- **Camera:** processed on the device by MediaPipe. Video is never stored or sent anywhere.
- **Voice:** uses Chrome's speech recognition, which may send audio to Google. Don't describe voice as on-device.
- **AI features:** off until you sign in. When you use one, the page's article text or the labels of on-screen items are sent to your ChatGPT account. "단순 보기" sends the article automatically once you're signed in. Values typed into fields are not sent. Sign-in tokens are stored in the extension's local storage, unencrypted.

## Known limits

- Webcam gaze isn't precise. Good lighting and a steady head help, and "번호" handles small or crowded targets.
- It only controls the top frame, so it can't click inside cross-origin iframes.
- Extensions can't run on `chrome://` pages or the Chrome Web Store.
- Some sites ignore script-generated clicks.
- Calibration assumes 100% page zoom.

## Development

```sh
(cd extension && zip -qr ../landing/nungil-extension.zip . -x '.*')  # the landing page's download
npm install
npm test          # gaze model, snapping, command parsing
npm run e2e       # real extension in Chromium, with a photo as the fake webcam
```

The e2e test runs real MediaPipe, but injects gaze frames and recognised commands. It doesn't test real eye movement or real speech.
