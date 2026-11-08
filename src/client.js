window.__ModuleLoader__.load({
  id: '@pedropaulovc/dsh-collaborative-docs',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    return {
      inject: ['slots', 'connection'],
      apply(ctx) {
        function DocumentsPanel() {
          const [attempt, setAttempt] = React.useState(0)
          const [state, setState] = React.useState({ status: 'loading', url: '', error: '' })
          const frame = React.useRef(null)
          React.useEffect(() => {
            const controller = new AbortController()
            let expectedOrigin = ''
            let finished = false
            setState({ status: 'loading', url: '', error: '' })
            const fail = (message) => {
              if (finished) return
              finished = true
              controller.abort()
              clearTimeout(timer)
              window.removeEventListener('message', onMessage)
              setState({ status: 'error', url: '', error: message })
            }
            const onMessage = (event) => {
              if (finished || !expectedOrigin || event.origin !== expectedOrigin || event.source !== frame.current?.contentWindow) return
              if (!event.data || event.data.type !== 'dsh-collaborative-docs:ready') return
              finished = true
              clearTimeout(timer)
              window.removeEventListener('message', onMessage)
              setState((current) => ({ ...current, status: 'ready' }))
            }
            window.addEventListener('message', onMessage)
            const timer = window.setTimeout(() => fail('The document editor did not finish loading. Retry to reconnect to the local server.'), 30000)
            const start = async () => {
              try {
                const result = await ctx.connection.rpc.call('/api', 'collaborative_docs_embed', { parentOrigin: window.location.origin }, controller.signal)
                if (controller.signal.aborted) return
                if (!result.ok) throw new Error(result.error.message)
                if (!result.value || typeof result.value.url !== 'string') throw new Error('The host returned no editor URL.')
                const target = new URL(result.value.url)
                if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || target.username || target.password || target.search || target.hash || !/^\/embedded\/[A-Za-z0-9_-]+\/$/.test(target.pathname)) throw new Error('The host returned an invalid local editor URL.')
                expectedOrigin = target.origin
                setState({ status: 'loading', url: target.href, error: '' })
              } catch (failure) {
                if (!controller.signal.aborted) fail(failure instanceof Error ? failure.message : 'Unable to start documents.')
              }
            }
            void start()
            return () => {
              finished = true
              controller.abort()
              clearTimeout(timer)
              window.removeEventListener('message', onMessage)
            }
          }, [attempt])
          return h('section', { 'aria-label': 'Documents', style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, width: '100%', flex: 1, fontFamily: 'inherit' } },
            state.status === 'loading' && h('p', { role: 'status', style: { padding: '16px', margin: 0 } }, 'Loading documents…'),
            state.status === 'error' && h('div', { role: 'alert', style: { padding: '24px' } },
              h('h1', null, 'Documents could not load'),
              h('p', null, state.error),
              h('button', { type: 'button', onClick: () => setAttempt((current) => current + 1) }, 'Retry'),
            ),
            state.url && h('iframe', {
              key: attempt,
              ref: frame,
              src: state.url,
              title: 'Collaborative documents',
              referrerPolicy: 'no-referrer',
              sandbox: 'allow-scripts allow-same-origin allow-forms allow-downloads',
              style: { display: 'block', width: '100%', height: '100%', flex: 1, minHeight: 0, border: 0 },
            }),
          )
        }
        function DocumentsIcon({ size = 20 }) {
          return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, 'aria-hidden': true },
            h('path', { d: 'M6 3h8l4 4v14H6z M14 3v5h4 M9 12h6 M9 16h6' }))
        }
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'collaborative-docs' }, DocumentsPanel))
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'collaborative-docs', label: 'Documents', order: 50 }, DocumentsIcon))
      },
    }
  },
})
