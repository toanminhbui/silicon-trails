const VERSION = 1;
const WALK_DISTANCE = 3;
const FLAG_KEYS = ['inspectedAccumulator','reachedArithmetic','storedResult','inspectedMemory','openedRtl'];
const INITIAL_MILESTONES = () => ({distance:0,inspectedAccumulator:false,reachedArithmetic:false,storedResult:false,inspectedMemory:false,openedRtl:false});

const STEPS = Object.freeze([
  {
    id:'walk',title:'Take flight',description:'Fly a little way through the machine. You can explore its components from every side.',
    hint:'Use W A S D to fly, Space to rise, and Q or C to descend. Travel at least three world units.',
    actionLabel:'Enter the world',action:'walk',
  },
  {
    id:'inspect-accumulator',title:'Meet the accumulator',description:'Find the glowing accumulator and inspect it. This register holds the number the processor is working on.',
    hint:'Follow the beacon to Accumulator A, then interact with it.',
    targetNodeId:'overview:a',actionLabel:'Find accumulator A',action:'focus-target',
  },
  {
    id:'run-instructions',title:'Make the computer add',description:'Run the first two instructions. LDI puts 7 in A; ADDI adds 5, giving 12.',
    hint:'Advance one instruction at a time and watch A change from 7 to 12.',
    targetNodeId:'overview:controller',actionLabel:'Run an instruction',action:'step-instruction',
  },
  {
    id:'save-value',title:'Give the number a home',description:'Run STORE 0x40. The processor sends 12 to memory and waits until that write is acknowledged.',
    hint:'Advance the STORE instruction. The byte is saved only when the memory response completes.',
    targetNodeId:'overview:ram',actionLabel:'Run the STORE',action:'step-instruction',
  },
  {
    id:'inspect-memory',title:'See what stayed',description:'Inspect memory address 0x40. Its saved byte is 0x0C, which is 12 in decimal.',
    hint:'Open memory and select address 40. Its value stays there until another write or a reset.',
    targetNodeId:'overview:ram',actionLabel:'Inspect saved memory',action:'inspect-memory',
  },
  {
    id:'open-rtl',title:'Look inside the machine',description:'Pause the game and open the RTL workshop to see the hardware that made this happen.',
    hint:'Press Escape to pause, then choose the RTL workshop. You can return to exploring afterward.',
    actionLabel:'Pause the game',action:'pause',
  },
]);

function completedMilestones(milestones) {
  return [milestones.distance >= WALK_DISTANCE,...FLAG_KEYS.map(key => milestones[key])];
}

/**
 * Event-driven onboarding. Buttons request real game actions; there is no Next
 * command. Milestones are remembered across steps so an early STORE still counts.
 */
export class Tutorial {
  constructor({onChange,onComplete} = {}) {
    this.onChange = typeof onChange === 'function' ? onChange : null;
    this.onComplete = typeof onComplete === 'function' ? onComplete : null;
    this.active = false;
    this.index = 0;
    this._milestones = INITIAL_MILESTONES();
  }

  get complete() { return this.index === STEPS.length; }

  getCurrent() {
    const common = {index:this.index,total:STEPS.length,active:this.active,complete:this.complete};
    return this.complete ? {
      id:'complete',...common,title:'Your computer is waiting',
      description:'You made the processor add, saved its result, and found that value in memory. Keep exploring or build something of your own.',
      hint:'Return to the world whenever you are ready.',actionLabel:'Keep exploring',action:'resume',
    } : {...STEPS[this.index],...common};
  }

  _notify() { this.onChange?.(this.getCurrent(),this.snapshot()); }

  start() {
    if (!this.complete && !this.active) { this.active = true; this._notify(); }
    return this.getCurrent();
  }

  // Suspending the game does not require stopping its tutorial. Use stop when
  // leaving onboarding; observe(open-rtl) must still arrive while it is active.
  stop() {
    if (this.active) { this.active = false; this._notify(); }
    return this.getCurrent();
  }

  reset() {
    this.active = false;
    this.index = 0;
    this._milestones = INITIAL_MILESTONES();
    this._notify();
    return this.getCurrent();
  }

  observe(event) {
    if (!this.active || this.complete || !event || typeof event !== 'object') return this.getCurrent();
    const before = JSON.stringify(this._milestones);
    const milestones = this._milestones;
    switch (event.type) {
      case 'move':
        // distance is a movement delta; totalDistance is an optional cumulative
        // alternative for a player controller that already keeps a distance sum.
        if (Number.isFinite(event.totalDistance) && event.totalDistance >= 0) {
          milestones.distance = Math.max(milestones.distance,Math.min(WALK_DISTANCE,event.totalDistance));
        } else if (Number.isFinite(event.distance) && event.distance > 0) {
          milestones.distance = Math.min(WALK_DISTANCE,milestones.distance + event.distance);
        }
        break;
      case 'inspect':
        if (event.id === 'overview:a') milestones.inspectedAccumulator = true;
        break;
      case 'step': {
        const a = event.cpu?.a;
        const validCpu = Number.isInteger(a) && a >= 0 && a <= 255;
        if (validCpu && (a === 12 || Number.isInteger(event.retired) && event.retired >= 2)) milestones.reachedArithmetic = true;
        break;
      }
      case 'memory-write':
        if (event.address === 0x40 && event.value === 12) milestones.storedResult = true;
        break;
      case 'memory-inspect':
        if (event.address === 0x40 && event.value === 12) milestones.inspectedMemory = true;
        break;
      case 'open-rtl':
        milestones.openedRtl = true;
        break;
      default:
        return this.getCurrent();
    }
    if (before === JSON.stringify(milestones)) return this.getCurrent();
    const completed = completedMilestones(milestones);
    while (this.index < completed.length && completed[this.index]) this.index++;
    if (this.complete) this.active = false;
    this._notify();
    if (this.complete) this.onComplete?.(this.getCurrent(),this.snapshot());
    return this.getCurrent();
  }

  snapshot() {
    return {version:VERSION,index:this.index,active:this.active,complete:this.complete,milestones:{...this._milestones}};
  }

  restore(data) {
    const milestones = data?.milestones;
    const valid = data && !Array.isArray(data) && data.version === VERSION &&
      Number.isInteger(data.index) && data.index >= 0 && data.index <= STEPS.length &&
      typeof data.active === 'boolean' && typeof data.complete === 'boolean' &&
      milestones && !Array.isArray(milestones) &&
      Number.isFinite(milestones.distance) && milestones.distance >= 0 && milestones.distance <= WALK_DISTANCE &&
      FLAG_KEYS.every(key => typeof milestones[key] === 'boolean');
    if (!valid) { this.reset(); return false; }
    const clean = {distance:milestones.distance,...Object.fromEntries(FLAG_KEYS.map(key => [key,milestones[key]]))};
    const completed = completedMilestones(clean);
    let index = 0;
    while (index < completed.length && completed[index]) index++;
    if (data.index !== index || data.complete !== (index === STEPS.length) || data.complete && data.active) {
      this.reset(); return false;
    }
    this.index = index;
    this.active = data.active;
    this._milestones = clean;
    this._notify();
    // Loading a finished tutorial should never award completion a second time.
    return true;
  }
}
