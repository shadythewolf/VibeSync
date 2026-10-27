/// <reference types="vite/client" />

/**
 * @types/react 19 removed the global `JSX` namespace in favour of `React.JSX`. Some renderer
 * modules annotate return types as `JSX.Element`; this shim keeps them compiling without
 * touching the JSX factory resolution (jsx: react-jsx still uses react/jsx-runtime).
 */
import type { JSX as ReactJSX } from 'react'

declare global {
  namespace JSX {
    type Element = ReactJSX.Element
    type ElementType = ReactJSX.ElementType
    type ElementClass = ReactJSX.ElementClass
    type IntrinsicElements = ReactJSX.IntrinsicElements
    type IntrinsicAttributes = ReactJSX.IntrinsicAttributes
    type IntrinsicClassAttributes<T> = ReactJSX.IntrinsicClassAttributes<T>
    type ElementChildrenAttribute = ReactJSX.ElementChildrenAttribute
    type LibraryManagedAttributes<C, P> = ReactJSX.LibraryManagedAttributes<C, P>
  }
}

export {}
