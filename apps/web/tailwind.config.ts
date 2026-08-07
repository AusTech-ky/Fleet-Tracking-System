import type { Config } from 'tailwindcss';

const c = (v: string) => `rgb(var(${v}) / <alpha-value>)`;

export default {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: c('--bg'),
        surface: { DEFAULT: c('--surface'), 2: c('--surface-2') },
        border: c('--border'),
        fg: { DEFAULT: c('--fg'), muted: c('--fg-muted'), subtle: c('--fg-subtle') },
        brand: { DEFAULT: c('--brand'), fg: c('--brand-fg'), weak: c('--brand-weak') },
        success: c('--success'),
        warning: c('--warning'),
        danger: c('--danger'),
      },
      boxShadow: {
        sm: 'var(--shadow-sm)',
        DEFAULT: 'var(--shadow)',
        lg: 'var(--shadow-lg)',
      },
      borderRadius: { xl: '0.75rem', '2xl': '1rem' },
    },
  },
  plugins: [],
} satisfies Config;
