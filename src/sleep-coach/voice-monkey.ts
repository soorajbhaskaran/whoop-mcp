// Minimal Voice Monkey client (https://voicemonkey.io/docs/api.html).
// Voice Monkey is an Alexa skill: "Speaker" devices take text-to-speech announcements, and
// "Routine Trigger" devices show up in the Alexa app as a "When this happens" trigger.

const API = "https://api-v3.voicemonkey.io";
type FetchImpl = typeof fetch;

export class VoiceMonkey {
  constructor(private token: string, private fetchImpl: FetchImpl = fetch) {}

  /** Speak `speech` on a Voice Monkey Speaker device (your Echo). */
  announce(speakerId: string, speech: string, extra: Record<string, string> = {}) {
    return this.post("/announce", { device: speakerId, speech, ...extra });
  }

  /** Fire an Alexa routine whose trigger is the given Voice Monkey Routine Trigger device. */
  trigger(triggerId: string) {
    return this.post("/trigger", { device: triggerId });
  }

  private async post(path: string, body: Record<string, string>): Promise<void> {
    const delays = [0, 2000, 5000];
    let lastErr = "";
    for (const delay of delays) {
      if (delay) await new Promise((r) => setTimeout(r, delay));
      const res = await this.fetchImpl(API + path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: this.token, ...body }),
      });
      if (res.ok) return;
      lastErr = `${res.status} ${await res.text().catch(() => "")}`.trim();
      // Only upstream Alexa failures are worth retrying; 4xx means config is wrong.
      if (res.status < 500) break;
    }
    throw new Error(`Voice Monkey ${path} failed: ${lastErr}`);
  }
}
