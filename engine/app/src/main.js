import './styles/main.scss';
import { App } from './App.js';
import { About } from './ui/About.js';

const model = new URLSearchParams(window.location.search).get('model') ?? 'mecha_01';
const app = new App(document.getElementById('app'));
new About(document.getElementById('app'), document.getElementById('about'));
const splash = document.getElementById('splash');
const INTRO = { fade: 1.5, pause: 0.5, fog: 1.5 }; // s: the title fades out, the view stays white a moment, then the fog lifts
splash?.style.setProperty('--fade', `${INTRO.fade}s`);
app
  .load(model)
  .catch((err) => {
    console.error(err);
    document.getElementById('app').insertAdjacentHTML('beforeend', `<p class="error">Could not load "${model}": ${err.message}</p>`);
  })
  .finally(() => { // the first model is in (or will not come): the title fades, then the fog lifts
    splash?.classList.add('splash--done');
    app.stage.reveal(INTRO.fog, INTRO.fade + INTRO.pause);
  });

// handy from the devtools console
window.app = app;
