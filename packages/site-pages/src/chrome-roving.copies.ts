// @ts-nocheck: the copy of lag-hud has parameter properties, and the package type-checks with `erasableSyntaxOnly`.
import { h, type Choice } from "./chrome.ts";

// The copies, word for word, that `rovingIndex` and `Segmented` replace (codeatlas class 7b9ed84e7523057c).
// They use the `h` of this package, which is the same function as their own copy of `h`.

/** The copy of lag-hud, `packages/site/src/chrome.ts`, the class `Segmented`. */
export class LagHudSegmented<T extends string> {
  private readonly buttons: HTMLButtonElement[];

  constructor(
    container: HTMLElement,
    private readonly choices: readonly Choice<T>[],
    private current: T,
    private readonly onChange: (value: T) => void,
  ) {
    this.buttons = choices.map((choice) => {
      const button = h(
        "button",
        { type: "button", role: "radio", "data-value": choice.value, title: choice.title, "aria-label": choice.title },
        choice.label,
      );
      button.addEventListener("click", () => this.choose(choice.value, false));
      return button;
    });
    container.replaceChildren(...this.buttons);
    container.addEventListener("keydown", (event) => {
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
      if (step === undefined) return;
      event.preventDefault();
      const index = this.choices.findIndex((c) => c.value === this.current);
      const next = this.choices[(index + step + this.choices.length) % this.choices.length]!;
      this.choose(next.value, true);
    });
    this.show();
  }

  /** The value of the control. */
  get value(): T {
    return this.current;
  }

  private choose(value: T, focus: boolean): void {
    const changed = value !== this.current;
    this.current = value;
    this.show();
    if (focus) this.buttons.find((b) => b.dataset["value"] === value)?.focus();
    if (changed) this.onChange(value);
  }

  private show(): void {
    for (const button of this.buttons) {
      const on = button.dataset["value"] === this.current;
      button.setAttribute("aria-checked", String(on));
      button.tabIndex = on ? 0 : -1;
    }
  }
}

/** The copy of ste-lint, `site/src/chrome.ts`, the class `Segmented`. */
export class SteLintSegmented<T extends string> {
  private readonly buttons: HTMLButtonElement[];
  private readonly choices: readonly Choice<T>[];
  private current: T;
  private readonly onChange: (value: T) => void;

  constructor(container: HTMLElement, choices: readonly Choice<T>[], current: T, onChange: (value: T) => void) {
    this.choices = choices;
    this.current = current;
    this.onChange = onChange;
    this.buttons = choices.map((choice) => {
      const button = h("button", { type: "button", role: "radio", "data-value": choice.value }, choice.label);
      button.addEventListener("click", () => this.choose(choice.value, false));
      return button;
    });
    container.replaceChildren(...this.buttons);
    container.addEventListener("keydown", (event) => {
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
      if (step === undefined) return;
      event.preventDefault();
      const index = this.choices.findIndex((c) => c.value === this.current);
      const next = this.choices[(index + step + this.choices.length) % this.choices.length]!;
      this.choose(next.value, true);
    });
    this.show();
  }

  get value(): T {
    return this.current;
  }

  /** This function sets the value. The listener gets no event. */
  set(value: T): void {
    this.current = value;
    this.show();
  }

  private choose(value: T, focus: boolean): void {
    const changed = value !== this.current;
    this.set(value);
    if (focus) this.buttons.find((b) => b.dataset["value"] === value)?.focus();
    if (changed) this.onChange(value);
  }

  private show(): void {
    for (const button of this.buttons) {
      const on = button.dataset["value"] === this.current;
      button.setAttribute("aria-checked", String(on));
      button.tabIndex = on ? 0 : -1;
    }
  }
}
