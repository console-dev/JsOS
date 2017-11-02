'use strict';

const PciDevice = require('../../../core/pci/pci-device');
const { MACAddress, Interface } = runtime.net;
const Buffer = require('buffer').Buffer;

const BUFFER_SIZE = 8192 + 16;

class RTL8139 {
  constructor() {
    this.ontransmit = this.ontransmit.bind(this);
    this.onIRQ = this.onIRQ.bind(this);
  }
  init(device) {
    // Initialize the PCI device
    this.irq = device.getIRQ();
    device.setPciCommandFlag(PciDevice.commandFlag.BusMaster);
    let iobar;
    let membar;
    for (const bar of device.bars) {
      if (!bar) continue;
      if (bar.type === 'io') {
        iobar = bar;
      } else if (bar.type === 'mem32') {
        membar = bar;
      }
    }
    if (!iobar || !membar) throw new Error('Very strange device O_o');
    this.iobar = iobar;

    // Initialize IO ports
    this.config_1 = iobar.resource.offsetPort(0x52);
    this.cmd = iobar.resource.offsetPort(0x37);
    this.rbstart = iobar.resource.offsetPort(0x30);
    this.cbr = iobar.resource.offsetPort(0x3A);
    this.imr = iobar.resource.offsetPort(0x3C);
    this.isr = iobar.resource.offsetPort(0x3E);
    this.rcr = iobar.resource.offsetPort(0x44);
    this.macports = [];
    for (let i = 0; i < 6; i++) {
      this.macports.push(iobar.resource.offsetPort(i));
    }

    // Turn on the card
    this.config_1.write8(0);

    // Reset controller
    this.cmd.write8(0x10);
    while ((this.cmd.read8() & 0x10) !== 0);

    // Initialize RX buffer
    const rxbuf = __SYSCALL.allocDMA();
    this.rbstart.write32(rxbuf.address);
    this.rxBuffer = new Buffer(rxbuf.buffer);

    // Initialize TX buffers
    this.txBuffers = [];
    for (let i = 0; i < 4; i++) {
      const buf = {};
      const txbuf = __SYSCALL.allocDMA();
      buf.address = txbuf.address;
      buf.buffer = new Buffer(txbuf.buffer);
      this.txBuffers.push(buf);
    }

    // Enable TOK and ROK interrupts
    this.imr.write16(0x3);

    // Set IRQ handler
    device.getIRQ().on(this.onIRQ);

    // Set WRAP+AB+AM+APM+AAP
    this.rcr.write32(0xf | (1 << 7));

    // Reset
    this.resetReceivePointer();

    // Enable RX/TX
    this.cmd.write8(0x0c);

    // Basic init
    this.iter = 3;

    // Get MAC address
    const macvals = [];
    for (let i = 0; i < 6; i++) {
      macvals.push(this.macports[i].read8());
    }
    this.mac = new MACAddress(...macvals);

    // Create interface object
    this.intf = new Interface(this.mac);
    this.intf.ontransmit = this.ontransmit;

    runtime.net.interfaceAdd(this.intf);
  }
  nextIter() {
    this.iter++;
    if (this.iter >= 4) {
      this.iter = 0;
    }
    return this.iter;
  }
  ontransmit(u8header, u8data) {
    const iter = this.nextIter();
    let size = u8header.length;
    this.txBuffers[iter].buffer.set(u8header);
    if (u8data) {
      size += u8data.length;
      this.txBuffers[iter].buffer.set(u8data, u8header.length);
    }

    const csN = this.iobar.resource.offsetPort(0x10 + (4 * iter));
    const tsN = this.iobar.resource.offsetPort(0x20 + (4 * iter));
    tsN.write32(this.txBuffers[iter].address);
    csN.write32(size & 0xFFF);
  }
  onreceive() {
    const status = this.rxBuffer.readUInt16LE(this.recvPointer);
    if (!(status & 0x1)) {
      this.resetReceivePointer();
      return;
    }
    const size = this.rxBuffer.readUInt16LE(this.recvPointer + 2);
    const _buf = this.rxBuffer.slice(this.recvPointer + 4, this.recvPointer + 4 + size);
    const buf = new Buffer(size);
    _buf.copy(buf);
    this.intf.receive(buf);
    this.resetReceivePointer();
    if (this.recvPointer >= BUFFER_SIZE) this.recvPointer = 0;
  }
  resetReceivePointer() {
    this.recvPointer = this.cbr.read16();
  }
  onIRQ() {
    while (1) {
      const isr = this.isr.read16();
      // console.log(`IRQ, ISR: ${isr}`);
      if (!isr) break;
      this.isr.write16(isr);
      this.irq.on(this.onIRQ);
      if (isr & 0x2) {
        this.resetReceivePointer();
      }
      if (isr & 0x1) {
        this.onreceive();
      }
    }
  }
}

runtime.pci.addDriver(0x10ec, 0x8139, new RTL8139);
