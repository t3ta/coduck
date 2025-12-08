<script lang="ts">
  import * as d3 from 'd3';
  // @ts-ignore - dagre-d3 ships without complete TypeScript types
  import dagreD3 from 'dagre-d3';
  import type { Job, JobStatus } from '../lib/types';

  type Props = {
    jobs?: Job[];
    onNodeClick?: (jobId: string) => void;
  };

  let { jobs = [], onNodeClick = undefined }: Props = $props();

  let containerEl: HTMLDivElement | null = null;
  let svgEl: SVGSVGElement | null = null;
  let innerEl: SVGGElement | null = null;

  const statusColors: Record<JobStatus, string> = {
    pending: '#9e9e9e',
    running: '#2196F3',
    done: '#4CAF50',
    failed: '#f44336',
    awaiting_input: '#FF9800',
    cancelled: '#757575',
  };

  function labelForJob(job: Job): string {
    return job.feature_part?.trim() || `#${job.id.slice(0, 8)}`;
  }

  function renderGraph(currentJobs: Job[]) {
    if (!svgEl || !innerEl) return;

    const graph = new dagreD3.graphlib.Graph({ compound: false }).setGraph({
      rankdir: 'TB',
      nodesep: 30,
      ranksep: 60,
      marginx: 24,
      marginy: 24,
    });
    graph.setDefaultEdgeLabel(() => ({}));

    const seenIds = new Set(currentJobs.map((job) => job.id));

    for (const job of currentJobs) {
      const color = statusColors[job.status] || '#9e9e9e';
      graph.setNode(job.id, {
        label: labelForJob(job),
        style: `fill: ${color}; stroke: #2c2c2c; stroke-width: 1.5px;`,
        labelStyle: 'fill: #fff; font-weight: 600;',
        rx: 6,
        ry: 6,
        padding: 10,
      });

      const deps = job.depends_on ?? [];
      for (const dep of deps) {
        if (!seenIds.has(dep)) {
          seenIds.add(dep);
          graph.setNode(dep, {
            label: `#${dep.slice(0, 8)}`,
            style: 'fill: #e0e0e0; stroke: #666; stroke-width: 1.2px;',
            labelStyle: 'fill: #333; font-weight: 600;',
            rx: 6,
            ry: 6,
            padding: 8,
          });
        }
        graph.setEdge(dep, job.id, { arrowhead: 'vee' });
      }
    }

    const svg = d3.select(svgEl);
    const inner = d3.select(innerEl);

    inner.selectAll('*').remove();

    const render = new dagreD3.render();
    render(inner, graph);

    const graphLabel = graph.graph();
    const graphWidth = (graphLabel.width ?? 0) + (graphLabel.marginx ?? 24) * 2;
    const graphHeight = (graphLabel.height ?? 0) + (graphLabel.marginy ?? 24) * 2;

    const minWidth = Math.max(graphWidth, containerEl?.clientWidth ?? 400, 400);
    const minHeight = Math.max(graphHeight, 320);

    svg.attr('width', minWidth);
    svg.attr('height', minHeight);

    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.5, 2])
      .on('zoom', (event) => {
        inner.attr('transform', event.transform);
      });

    svg.call(
      zoom as unknown as (
        selection: d3.Selection<SVGSVGElement, unknown, null, undefined>
      ) => void
    );

    const initialScale = containerEl
      ? Math.min((containerEl.clientWidth - 40) / graphWidth, 1)
      : 1;
    const initialTranslateX =
      Math.max(((containerEl?.clientWidth ?? minWidth) - graphWidth * initialScale) / 2, 0) + 20;
    const initialTranslateY = 20;

    svg.call(
      zoom.transform as unknown as (
        selection: d3.Selection<SVGSVGElement, unknown, null, undefined>,
        transform: d3.ZoomTransform
      ) => void,
      d3.zoomIdentity.translate(initialTranslateX, initialTranslateY).scale(initialScale || 1)
    );

    inner.selectAll<SVGGElement, string>('g.node').on('click', (_event, id) => {
      if (typeof id === 'string') {
        onNodeClick?.(id);
      }
    });
  }

  $effect(() => {
    renderGraph(jobs);
  });
</script>

<div class="dag-graph" bind:this={containerEl}>
  {#if jobs.length === 0}
    <p class="empty">No jobs to display</p>
  {:else}
    <svg bind:this={svgEl} aria-label="DAG graph">
      <g bind:this={innerEl}></g>
    </svg>
  {/if}
</div>

<style>
  .dag-graph {
    width: 100%;
    background: #fff;
    border: 1px solid #ddd;
    border-radius: 8px;
    padding: 12px;
    overflow: auto;
    min-height: 320px;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.03);
  }

  svg {
    display: block;
  }

  .node rect {
    cursor: pointer;
  }

  .node rect:hover {
    filter: brightness(0.95);
  }

  .edgePath path {
    stroke: #555;
    stroke-width: 1.5px;
    fill: none;
  }

  .empty {
    margin: 0;
    color: #666;
    text-align: center;
  }
</style>
