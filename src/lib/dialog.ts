// The app's dialog (Dialog.svelte): its buttons and form fields. The store opens it
// (`app.choose`, `app.prompt` and forms) and waits for the answer.
import type { ButtonRole } from "./platform";

export interface DialogButton {
  label: string;
  value: string;
  /** Decides where the button sits on each OS (`arrangeDialogButtons`), and
   *  which one Enter (primary) and Escape (cancel) stand for. */
  role?: ButtonRole;
  /** Drawn in the danger colour: a primary that destroys something, or a destructive alternative. */
  danger?: boolean;
  /** Focused when the dialog opens, instead of the primary button. Set it on
   *  Cancel for irreversible confirmations, so a stray Enter destroys nothing. */
  focus?: boolean;
}

/** A dialog's Cancel button, which Escape stands for (answers "cancel"). */
export const CANCEL: DialogButton = { label: "Cancel", value: "cancel", role: "cancel" };

/** One field of a dialog form: a labelled text input, masked (with a reveal button) if asked. */
export interface DialogField {
  label: string;
  /** Shown under the label; empty for none. */
  help: string;
  masked: boolean;
  value: string;
}

export interface DialogState {
  title: string;
  message?: string;
  input?: { value: string; placeholder?: string; selectStem?: boolean };
  /** A form of several fields; their values come back in `values`, in order. */
  fields?: DialogField[];
  buttons: DialogButton[];
  resolve: (r: DialogAnswer) => void;
}

/** What the user answered: the button pressed, the input's value, and the form's values. */
export interface DialogAnswer {
  button: string;
  value: string;
  values: string[];
}
