export function createLoadingSkeleton(React) {
  const h = React.createElement;
  return function LoadingSkeleton({ label = 'Loading…', rows = 3, inline = false }) {
    const [visible, setVisible] = React.useState(false);
    React.useEffect(() => {
      const timer = setTimeout(() => setVisible(true), 180);
      return () => clearTimeout(timer);
    }, []);
    return h('span', { role: 'status', className: `notch-loading-skeleton${inline ? ' notch-loading-inline' : ''}`, 'data-visible': visible },
      h('span', { className: 'notch-loading-label' }, label),
      ...Array.from({ length: rows }, (_, index) => h('span', { key: index, className: 'notch-skeleton-row', 'aria-hidden': true },
        h('span', { className: 'notch-skeleton-line' }),
        inline ? null : h('span', { className: 'notch-skeleton-line notch-skeleton-detail' }))));
  };
}
