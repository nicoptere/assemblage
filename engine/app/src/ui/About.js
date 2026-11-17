import { CornerButton } from './CornerButton.js';

/**
 * A "?" button in the top left corner that shows and hides `section` (the text about the
 * experiment, in index.html) under it. Escape, or a click anywhere else, hides it again.
 */
export class About extends CornerButton {
  constructor(parent, section) {
    super(parent, section, { label: '?', title: 'About', side: 'left' });
  }
}
