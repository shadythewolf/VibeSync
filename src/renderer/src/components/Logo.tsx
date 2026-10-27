/**
 * VibeSync logo mark (inline SVG). The ring and bars follow the active theme accent
 * colours through CSS variables so the chrome always matches the canvas.
 */
import { useId, type ReactElement } from 'react'
import { cx } from '@renderer/utils/classNames'

export interface LogoProps {
  size?: number
  className?: string
  /** Use fixed brand colours instead of the live theme. */
  brand?: boolean
  title?: string
}

export function Logo({ size = 20, className, brand = false, title = 'VibeSync' }: LogoProps): ReactElement {
  const id = useId().replace(/:/g, '')
  const ringId = `vd-ring-${id}`
  const barsId = `vd-bars-${id}`
  const c1 = brand ? '#00F0FF' : 'var(--accent, #00F0FF)'
  const c2 = brand ? '#B44CFF' : 'var(--accent-3, #B44CFF)'
  const c3 = brand ? '#FF3BD4' : 'var(--accent-2, #FF3BD4)'
  return (
    <svg
      className={cx('logo', className)}
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role="img"
      aria-label={title}
    >
      <defs>
        <linearGradient id={ringId} gradientUnits="userSpaceOnUse" x1="10" y1="10" x2="54" y2="54">
          <stop offset="0" style={{ stopColor: c1 }} />
          <stop offset="0.5" style={{ stopColor: c2 }} />
          <stop offset="1" style={{ stopColor: c3 }} />
        </linearGradient>
        <linearGradient id={barsId} gradientUnits="userSpaceOnUse" x1="14" y1="0" x2="50" y2="0">
          <stop offset="0" style={{ stopColor: c1 }} />
          <stop offset="0.5" style={{ stopColor: c2 }} />
          <stop offset="1" style={{ stopColor: c3 }} />
        </linearGradient>
      </defs>
      <rect x="0" y="0" width="64" height="64" rx="14" fill="#0B0C14" />
      <rect x="0.5" y="0.5" width="63" height="63" rx="13.5" fill="none" stroke="#FFFFFF" strokeOpacity="0.07" />
      <circle cx="32" cy="32" r="22.5" fill="#11131F" />
      <circle cx="32" cy="32" r="24.5" fill="none" stroke={`url(#${ringId})`} strokeWidth="3.2" strokeDasharray="66.2 10.8" transform="rotate(-78 32 32)" />
      <g fill={`url(#${barsId})`}>
        {[11.2, 14.5, 19.0, 23.9, 19.0, 14.5, 11.2].map((height, i) => (
          <rect key={i} x={14.7 + i * 5.25} y={44.4 - height} width="3.1" height={height} rx="1.55" />
        ))}
      </g>
    </svg>
  )
}

export default Logo
