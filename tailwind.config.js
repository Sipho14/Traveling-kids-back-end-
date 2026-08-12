/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        transit: {
          navy: '#16233F',    // primary — dusk-route trust
          navy2: '#1F335A',
          amber: '#F4B400',   // school-bus signal — the one accent
          amber2: '#D99A00',
          cream: '#F7F4EC',   // background
          slate: '#65708A',   // secondary text
          line: '#E4E0D4',
          good: '#2E7D5B',
          bad: '#C1443D'
        }
      },
      fontFamily: {
        display: ['"Space Grotesk"', 'sans-serif'],
        body: ['"Inter"', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'monospace']
      }
    }
  },
  plugins: []
};
