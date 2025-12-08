<script lang="ts">
  import { onMount } from 'svelte';
  import * as d3 from 'd3';
  import { graphlib, layout } from '@dagrejs/dagre';
  import type { Job, JobStatus } from '../lib/types';

  type Props = {
    jobs?: Job[];
    onNodeClick?: (jobId: string) => void;
  };

  let { jobs = [], onNodeClick = undefined }: Props = $props();

  let containerEl: HTMLDivElement | null = null;
  let svgEl: SVGSVGElement | null = null;
  let innerEl: SVGGElement | null = null;
  let mounted = $state(false);
  let previousJobsHash = $state('');

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

  function computeJobsHash(currentJobs: Job[]): string {
    const sortedJobs = [...currentJobs].sort((a, b) => a.id.localeCompare(b.id));
    return sortedJobs.map(j => `${j.id}:${j.status}:${(j.depends_on ?? []).join(',')}`).join('|');
  }

  function renderGraph(currentJobs: Job[]) {
    if (!svgEl || !innerEl || !mounted) return;

    const graph = new graphlib.Graph({ compound: false }).setGraph({
      rankdir: 'TB',
      nodesep: 50,
      ranksep: 80,
      marginx: 30,
      marginy: 30,
    });
    graph.setDefaultEdgeLabel(() => ({}));

    const seenIds = new Set(currentJobs.map((job) => job.id));
    const jobMap = new Map(currentJobs.map(j => [j.id, j]));

    for (const job of currentJobs) {
      graph.setNode(job.id, {
        label: labelForJob(job),
        width: 120,
        height: 40,
        job,
      });

      const deps = job.depends_on ?? [];
      for (const dep of deps) {
        if (!seenIds.has(dep)) {
          seenIds.add(dep);
          graph.setNode(dep, {
            label: `#${dep.slice(0, 8)}`,
            width: 100,
            height: 35,
            job: null,
          });
        }
        graph.setEdge(dep, job.id);
      }
    }

    layout(graph);

    const svg = d3.select(svgEl);
    const inner = d3.select(innerEl);

    inner.selectAll('*').remove();

    // Create arrow marker for edges
    const defs = svg.select('defs').empty() ? svg.append('defs') : svg.select('defs');
    defs.selectAll('marker').remove();
    defs.append('marker')
      .attr('id', 'arrowhead')
      .attr('viewBox', '0 0 10 10')
      .attr('refX', 9)
      .attr('refY', 5)
      .attr('markerWidth', 6)
      .attr('markerHeight', 6)
      .attr('orient', 'auto')
      .append('path')
      .attr('d', 'M 0 0 L 10 5 L 0 10 z')
      .attr('fill', '#555');

    // Draw edges
    graph.edges().forEach((e) => {
      const edge = graph.edge(e);
      if (!edge.points || edge.points.length === 0) return;
      
      const lineFunction = d3.line<{ x: number; y: number }>()
        .x(d => d.x)
        .y(d => d.y)
        .curve(d3.curveBasis);

      inner.append('path')
        .attr('class', 'edgePath')
        .attr('d', lineFunction(edge.points))
        .attr('fill', 'none')
        .attr('stroke', '#555')
        .attr('stroke-width', 2)
        .attr('marker-end', 'url(#arrowhead)');
    });

    // Draw nodes
    graph.nodes().forEach((nodeId) => {
      const node = graph.node(nodeId);
      const job = node.job as Job | null;
      const color = job ? (statusColors[job.status] || '#9e9e9e') : '#e0e0e0';
      const textColor = job ? '#fff' : '#333';
      
      const g = inner.append('g')
        .attr('class', 'node')
        .attr('id', nodeId)
        .attr('transform', `translate(${node.x - node.width / 2}, ${node.y - node.height / 2})`)
        .attr('tabindex', '0')
        .attr('role', 'button')
        .attr('aria-label', job ? `Job ${labelForJob(job)}, status: ${job.status}` : `Job ${nodeId.slice(0, 8)}`);

      g.append('rect')
        .attr('width', node.width)
        .attr('height', node.height)
        .attr('rx', 6)
        .attr('ry', 6)
        .attr('fill', color)
        .attr('stroke', job ? '#2c2c2c' : '#666')
        .attr('stroke-width', job ? 1.5 : 1.2);

      g.append('text')
        .attr('x', node.width / 2)
        .attr('y', node.height / 2)
        .attr('text-anchor', 'middle')
        .attr('dominant-baseline', 'middle')
        .attr('fill', textColor)
        .attr('font-weight', 600)
        .text(node.label);

      // Add click and keyboard event handlers
      g.on('click', (event) => {
        event.preventDefault();
        if (onNodeClick) onNodeClick(nodeId);
      });

      g.on('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          if (onNodeClick) onNodeClick(nodeId);
        }
      });
    });

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

    svg.call(zoom);

    const initialScale = containerEl
      ? Math.min((containerEl.clientWidth - 40) / graphWidth, 1)
      : 1;
    const initialTranslateX =
      Math.max(((containerEl?.clientWidth ?? minWidth) - graphWidth * initialScale) / 2, 0) + 20;
    const initialTranslateY = 20;

    svg.call(zoom.transform, d3.zoomIdentity.translate(initialTranslateX, initialTranslateY).scale(initialScale || 1));
  }

  onMount(() => {
    mounted = true;
    return () => {
      mounted = false;
    };
  });

  $effect(() => {
    if (mounted && jobs.length > 0) {
      const newHash = computeJobsHash(jobs);
      if (newHash !== previousJobsHash) {
        previousJobsHash = newHash;
        renderGraph(jobs);
      }
    }
  });
</script>

<div class="dag-graph" bind:this={containerEl}>
  {#if jobs.length === 0}
    <p class="empty">No jobs to display</p>
  {:else}
    <svg bind:this={svgEl} role="img" aria-labelledby="dag-graph-title dag-graph-desc">
      <title id="dag-graph-title">Directed Acyclic Graph of jobs</title>
      <desc id="dag-graph-desc">Interactive visualization of job dependencies. Use Tab to navigate nodes and Enter or Space to activate.</desc>
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

  :global(.dag-graph .node rect) {
    cursor: pointer;
  }

  :global(.dag-graph .node rect:hover) {
    filter: brightness(0.9);
  }

  :global(.dag-graph .edgePath path) {
    stroke: #555;
    stroke-width: 2px;
    fill: none;
  }

  :global(.dag-graph .edgePath marker path) {
    fill: #555;
  }

  .empty {
    margin: 0;
    color: #666;
    text-align: center;
  }
</style>
