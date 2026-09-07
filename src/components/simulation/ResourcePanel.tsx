import { useEffect, useRef, useState } from 'react';
import type { ResourceState } from '../../simulation/types';
import styles from './ResourcePanel.module.css';

const STATUS_GLYPH: Record<ResourceState['status'], string> = {
  available: '○',
  allocated: '◉',
  depleted: '●',
  unavailable: '⊘',
};

export function ResourcePanel({ resources }: { resources: ResourceState[] }) {
  return (
    <section className="panel">
      <div className="panel__head">
        <span className="u-label">Resources</span>
      </div>
      <div className="panel__body">
        <ul className={styles.list}>
          {resources.map((r) => (
            <ResourceRow key={r.id} resource={r} />
          ))}
        </ul>
      </div>
    </section>
  );
}

function ResourceRow({ resource }: { resource: ResourceState }) {
  const [flash, setFlash] = useState(false);
  const prev = useRef(resource.status);

  useEffect(() => {
    if (prev.current !== resource.status) {
      prev.current = resource.status;
      setFlash(true);
      const id = setTimeout(() => setFlash(false), 700);
      return () => clearTimeout(id);
    }
  }, [resource.status]);

  return (
    <li className={`${styles.row} ${flash ? styles.flash : ''}`}>
      <span className={`${styles.glyph} ${styles[resource.status]}`} aria-hidden>
        {STATUS_GLYPH[resource.status]}
      </span>
      <span className={styles.name}>{resource.label}</span>
      <span className={`${styles.status} ${styles[resource.status]}`}>{resource.status}</span>
      {resource.detail && <span className={styles.detail}>{resource.detail}</span>}
    </li>
  );
}
