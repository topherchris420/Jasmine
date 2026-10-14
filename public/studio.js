const helpButton = document.getElementById('help-button');
const helpPanel = document.getElementById('help-panel');
const walkthrough = document.getElementById('walkthrough');

function closeHelp() {
  helpPanel.hidden = true;
  helpButton.setAttribute('aria-expanded', 'false');
}

helpButton.addEventListener('click', () => {
  const expanded = helpButton.getAttribute('aria-expanded') === 'true';
  helpPanel.hidden = expanded;
  helpButton.setAttribute('aria-expanded', String(!expanded));
});

document.addEventListener('click', (event) => {
  if (!event.target.closest('.help-wrap')) closeHelp();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !helpPanel.hidden) {
    closeHelp();
    helpButton.focus();
  }
});

for (const id of ['demo-button', 'help-tour']) {
  document.getElementById(id).addEventListener('click', () => {
    closeHelp();
    walkthrough.showModal();
  });
}
