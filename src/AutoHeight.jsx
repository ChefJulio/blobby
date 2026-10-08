import { useLayoutEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';

const HEIGHT_TRANSITION = { duration: 0.32, ease: [0.2, 0, 0, 1] };

// Animates its height to follow its content. The content is measured with a
// ResizeObserver, so any change - a mode switch, text wrapping, an embed
// loading, a help panel opening - glides instead of snapping.
export default function AutoHeight({ children }) {
  const innerRef = useRef(null);
  const [height, setHeight] = useState('auto');

  useLayoutEffect(() => {
    const ro = new ResizeObserver(([entry]) => setHeight(entry.borderBoxSize[0].blockSize));
    ro.observe(innerRef.current);
    return () => ro.disconnect();
  }, []);

  return (
    <motion.div
      initial={false}
      animate={{ height }}
      transition={HEIGHT_TRANSITION}
      style={{ overflow: 'hidden' }}
    >
      <div ref={innerRef}>{children}</div>
    </motion.div>
  );
}
