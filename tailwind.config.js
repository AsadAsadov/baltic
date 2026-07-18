module.exports = {
  content: ['./index.html', './server.js'],
  safelist: [
    'grid-rows-[1fr]', 'grid-rows-[0fr]', 'duration-[450ms]', 'duration-[500ms]',
    { pattern: /^(bg|text|border|ring|shadow|from|via|to)-(forest|wood|stone|green|red|amber|blue)-(50|100|200|300|400|500|600|700|800|900|950)(\/\d+)?$/ },
    { pattern: /^(grid|md:grid|lg:grid)-cols-(1|2|3|4)$/ }
  ],
  theme: {
    extend: {
      colors: { forest: { 50:'#f3f7f3', 600:'#2f6f3e', 700:'#245c34', 800:'#1c482a', 950:'#0f2718' }, wood: { 200:'#e7cda8', 500:'#b88448', 600:'#9a6936' } }
    }
  },
  plugins: []
};
