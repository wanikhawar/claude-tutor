// The images attached to the message being composed, owned by the Session or lesson
// rather than by an attach button: buttons come and go as the composer changes (Answer ↔
// Ask Clawd), but an image being prepared still belongs to the conversation.

import type { App, TFile } from "obsidian";
import { MAX_IMAGES, fromVault, prepareImage, restoreImages, type Img } from "./images";
import { store } from "./store.svelte";

export class Attachments {
  images = $state<Img[]>([]);
  /** Images still being read or scaled down. Sending waits for them. */
  preparing = $state(0);
  // Bumped by `clear()`: images still being prepared are dropped instead of attached.
  private epoch = 0;

  get full() {
    return this.images.length >= MAX_IMAGES;
  }

  private tooMany() {
    store.error = `You can attach up to ${MAX_IMAGES} images at a time.`;
  }

  /** Prepare one image and attach it, unless everything was cleared meanwhile. */
  private async attach(prepare: () => Promise<Img>) {
    const started = this.epoch;
    this.preparing++;
    try {
      const img = await prepare();
      if (this.epoch !== started) return;
      // Read `images` only after the await, so concurrent adds don't overwrite each other.
      if (this.full) return this.tooMany();
      this.images = [...this.images, img];
    } catch (e) {
      if (this.epoch === started) store.error = e instanceof Error ? e.message : String(e);
    } finally {
      if (this.epoch === started) this.preparing--;
    }
  }

  /** Pasted, dropped or uploaded files. */
  async add(files: Blob[], names: string[] = []) {
    const started = this.epoch;
    for (let i = 0; i < files.length && this.epoch === started; i++) {
      if (this.full) return this.tooMany();
      await this.attach(() => prepareImage(files[i], names[i] ?? (files[i] as File).name ?? "image"));
    }
  }

  addFromVault(app: App, file: TFile) {
    if (this.full) return this.tooMany();
    void this.attach(() => fromVault(app, file));
  }

  remove(i: number) {
    this.images = this.images.filter((_, j) => j !== i);
  }

  /** Take the attached images for sending (and clear the composer). */
  take(): Img[] {
    const taken = this.images;
    this.images = [];
    return taken;
  }

  /** A cancelled message's images, back in the composer next to any attached since. */
  restore(taken: Img[]) {
    const r = restoreImages(taken, this.images);
    this.images = r.images;
    if (r.dropped) store.error = `Only ${MAX_IMAGES} images fit, so the ${r.dropped} newest weren't kept.`;
  }

  /** Drop everything, including images still being prepared (a new step, lesson or view). */
  clear() {
    this.epoch++;
    this.preparing = 0;
    this.images = [];
  }
}
