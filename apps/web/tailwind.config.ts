import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        display: ['var(--font-display)', 'ui-monospace', 'monospace'],
        sans: ['var(--font-sans)', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'monospace'],
      },
      colors: {
        bg: '#0a0b0e',
        panel: '#101217',
        panel2: '#161922',
        line: 'rgba(255,255,255,0.075)',
        line2: 'rgba(255,255,255,0.14)',
        ink: '#e9e7df',
        dim: '#9aa1ab',
        faint: '#5b626d',
        amber: '#ffb000',
        amberdeep: '#c8780a',
        // status signal palette
        sig: {
          starting: '#7b828c',
          running: '#39d4cf',
          orchestrating: '#ffb000',
          awaiting: '#b08cff',
          completed: '#54e08a',
          failed: '#ff5d5d',
          killed: '#ff7a45',
        },
      },
      boxShadow: {
        glow: '0 0 0 1px rgba(255,176,0,0.25), 0 0 24px -6px rgba(255,176,0,0.35)',
        panel: '0 1px 0 0 rgba(255,255,255,0.04) inset, 0 12px 40px -20px rgba(0,0,0,0.8)',
      },
      keyframes: {
        pulseGlow: {
          '0%,100%': { opacity: '1', boxShadow: '0 0 0 0 currentColor' },
          '50%': { opacity: '0.55', boxShadow: '0 0 10px 1px currentColor' },
        },
        sweep: {
          '0%': { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(100%)' },
        },
        riseIn: {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        blink: { '0%,100%': { opacity: '1' }, '50%': { opacity: '0.2' } },
      },
      animation: {
        pulseGlow: 'pulseGlow 1.8s ease-in-out infinite',
        sweep: 'sweep 1.4s linear infinite',
        riseIn: 'riseIn 0.4s cubic-bezier(0.22,1,0.36,1) both',
        blink: 'blink 1.1s step-start infinite',
      },
    },
  },
  plugins: [],
};

export default config;
