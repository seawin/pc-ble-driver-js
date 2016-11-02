'use strict';

const { splitArray } = require('../util/arrayUtil');
const { arrayToInt } = require('../util/intArrayConv');
const { ControlPointOpcode, ErrorCode, createError } = require('./dfuConstants');
const DfuNotificationQueue = require('./dfuNotificationQueue');
const DfuPacketWriter = require('./dfuPacketWriter');

const DEFAULT_MTU_SIZE = 20;

class DfuObjectWriter {

    constructor(adapter, controlPointCharacteristicId, packetCharacteristicId) {
        this._adapter = adapter;
        this._packetCharacteristicId = packetCharacteristicId;
        this._notificationQueue = new DfuNotificationQueue(adapter, controlPointCharacteristicId);
        this._mtuSize = DEFAULT_MTU_SIZE;
        this._abort = false;
    }

    /**
     * Writes DFU data object according to the given MTU size.
     *
     * @param data byte array that should be written
     * @param offset the offset to continue from (optional)
     * @param crc32 the CRC32 value to continue from (optional)
     * @returns promise that returns progress info (CRC32 value and offset)
     */
    writeObject(data, offset, crc32) {
        const packets = splitArray(data, this._mtuSize);
        const packetWriter = this._createPacketWriter(offset, crc32);
        this._notificationQueue.startListening();
        return this._writePackets(packetWriter, packets)
            .then(() => {
                this._notificationQueue.stopListening();
                return {
                    offset: packetWriter.getOffset(),
                    crc32: packetWriter.getCrc32()
                };
            }).catch(error => {
                this._notificationQueue.stopListening();
                throw error;
            });
    }

    /*
     * Specifies that the object writer should abort before the next packet is
     * written. An error with code ABORTED will be thrown.
     */
    abort() {
        this._abort = true;
    }

    /**
     * Sets packet receipt notification (PRN) value, which specifies how many
     * packages should be sent before receiving receipt.
     *
     * @param prn the PRN value (disabled if 0)
     */
    setPrn(prn) {
        this._prn = prn;
    }

    /**
     * Sets maximum transmission unit (MTU) size. This defines the size of
     * packets that are transferred to the device. Default is 20.
     *
     * @param mtuSize the MTU size
     */
    setMtuSize(mtuSize) {
        this._mtuSize = mtuSize;
    }

    _writePackets(packetWriter, packets) {
        return packets.reduce((prevPromise, packet) => {
            return prevPromise.then(() => this._writePacket(packetWriter, packet));
        }, Promise.resolve());
    }

    _writePacket(packetWriter, packet) {
        return this._checkAbortState()
            .then(() => packetWriter.writePacket(packet))
            .then(progressInfo => {
                if (progressInfo) {
                    return this._validateProgress(progressInfo);
                }
            });
    }

    _createPacketWriter(offset, crc32) {
        const writer = new DfuPacketWriter(this._adapter, this._packetCharacteristicId);
        writer.setOffset(offset);
        writer.setCrc32(crc32);
        writer.setPrn(this._prn);
        return writer;
    }

    _checkAbortState() {
        if (this._abort) {
            return Promise.reject(createError(ErrorCode.ABORTED, 'Abort was triggered.'));
        }
        return Promise.resolve();
    }

    _validateProgress(progressInfo) {
        return this._notificationQueue.readNext(ControlPointOpcode.CALCULATE_CRC)
            .then(notification => {
                this._validateOffset(notification, progressInfo.offset);
                this._validateCrc32(notification, progressInfo.crc32);
            });
    }

    _validateOffset(notification, offset) {
        const offsetArray = notification.slice(3, 7);
        const responseOffset = arrayToInt(offsetArray);
        if (responseOffset !== offset) {
            throw createError(ErrorCode.INVALID_OFFSET, `Error when validating offset. ` +
                `Got ${responseOffset}, but expected ${offset}.`);
        }
    }

    _validateCrc32(notification, crc32) {
        const crc32Array = notification.slice(7, 11);
        const responseCrc = arrayToInt(crc32Array);
        if (responseCrc !== crc32) {
            throw createError(ErrorCode.INVALID_CRC, `Error when validating CRC. ` +
                `Got ${responseCrc}, but expected ${crc32}.`);
        }
    }
}

module.exports = DfuObjectWriter;
