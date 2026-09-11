/** Vite turns an imported image into the address it is served from. */
declare module '*.svg' {
  const url: string
  export default url
}
