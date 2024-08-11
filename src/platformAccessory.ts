import {CharacteristicValue, Nullable, PlatformAccessory, Service} from 'homebridge';

import {RinnaiControlrHomebridgePlatform} from './platform';
import {
    API_KEY_RECIRCULATION_DURATION,
    API_KEY_SET_PRIORITY_STATUS, API_KEY_SET_RECIRCULATION_ENABLED,
    API_KEY_SET_TEMPERATURE,
    API_KEY_DO_MAINTENANCE_RETRIEVAL,
    API_VALUE_TRUE,
    MANUFACTURER,
    SET_STATE_WAIT_TIME_MILLIS,
    TemperatureUnits, THERMOSTAT_TARGET_TEMP_STEP_VALUE,
    WATER_HEATER_SMALL_STEP_VALUE_IN_F,
    THERMOSTAT_CURRENT_TEMP_MAX_VALUE,
    THERMOSTAT_CURRENT_TEMP_MIN_VALUE,
    UNKNOWN,
    MAINTENANCE_RETRIEVAL_IDLING_THROTTLE_MILLIS,
    MAINTENANCE_RETRIEVAL_RUNNING_THROTTLE_MILLIS,
    THERMOSTAT_CURRENT_TEMP_STEP_VALUE,
    WATER_HEATER_BIG_STEP_START_IN_F,
    WATER_HEATER_BIG_STEP_VALUE_IN_F,
} from './constants';
import _ from 'lodash';
import {celsiusToFahrenheit, fahrenheitToCelsius} from './util';

const RECIRC_SERVICE_NAME = 'Recirculation';

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export class RinnaiControlrPlatformAccessory {
    private service: Service;
    // Controller unit
    private readonly isFahrenheit: boolean;
    // All values below are in C as required by HomeKit
    private readonly minValue: number;
    private readonly maxValue: number;
    private targetTemperature!: number;
    private outletTemperature!: number;
    private isRunning!: boolean;

    constructor(
        private readonly platform: RinnaiControlrHomebridgePlatform,
        private readonly accessory: PlatformAccessory,
    ) {
        this.isFahrenheit = this.platform.getConfig().temperatureUnits === TemperatureUnits.F;

        this.minValue = this.platform.getConfig().minimumTemperature;
        this.maxValue = this.platform.getConfig().maximumTemperature;
        if (this.isFahrenheit) {
            this.minValue = fahrenheitToCelsius(this.minValue);
            this.maxValue = fahrenheitToCelsius(this.maxValue);
        }

        this.minValue = Math.floor(this.minValue / THERMOSTAT_TARGET_TEMP_STEP_VALUE) * THERMOSTAT_TARGET_TEMP_STEP_VALUE;
        this.maxValue = Math.ceil(this.maxValue / THERMOSTAT_TARGET_TEMP_STEP_VALUE) * THERMOSTAT_TARGET_TEMP_STEP_VALUE;
        this.platform.log.info(`Water Heater ${this.accessory.context.id}: Target Temperature Slider Min: ${this.minValue}, Max: ${this.maxValue}`);

        this.extractDeviceInfo();

        // set accessory information
        this.accessory.getService(this.platform.Service.AccessoryInformation)!
            .setCharacteristic(this.platform.Characteristic.Manufacturer, MANUFACTURER)
            .setCharacteristic(this.platform.Characteristic.Model, this.accessory.context.model || UNKNOWN)
            .setCharacteristic(this.platform.Characteristic.SerialNumber, this.accessory.context.id || UNKNOWN);

        const recirculationService = this.bindRecirculation(this.platform.getConfig().recirculationOnly);

        // Enable temperature control
        if (!this.platform.getConfig().recirculationOnly) {
            this.service = this.accessory.getService(this.platform.Service.Thermostat)
                || this.accessory.addService(this.platform.Service.Thermostat);
            this.service.setCharacteristic(this.platform.Characteristic.Name, this.accessory.context.device_name);

            this.bindTemperature();
            this.bindStaticValues();
        } else {
            this.service = recirculationService!;
        }
    }

    extractDeviceInfo() {
        this.platform.log.debug(`Setting accessory details from device payload: ${JSON.stringify(this.accessory.context, null, 2)}`);

        if (this.accessory.context.info) {
            this.targetTemperature = this.isFahrenheit && this.accessory.context.info.domestic_temperature
                ? fahrenheitToCelsius(this.accessory.context.info.domestic_temperature)
                : this.accessory.context.info.domestic_temperature;

            this.outletTemperature = this.isFahrenheit && this.accessory.context.info.m02_outlet_temperature
                ? fahrenheitToCelsius(this.accessory.context.info.m02_outlet_temperature)
                : this.accessory.context.info.m02_outlet_temperature;

            this.isRunning = this.accessory.context.info.domestic_combustion === API_VALUE_TRUE;
        } else {
            this.platform.log.error(`Cannot extract details from ${JSON.stringify(this.accessory.context, null, 2)}`);
        }

        this.platform.log.debug(`Water Heater ${this.accessory.context.id}: ` +
            `targetTemperature = ${this.targetTemperature}, ` +
            `outletTemperature = ${this.outletTemperature}, ` +
            `isRunning = ${this.isRunning} ` +
            `recirculateActive = ${this.accessory.context.shadow.recirculation_enabled}`);
    }

    bindTemperature() {
        this.service.getCharacteristic(this.platform.Characteristic.TargetTemperature)
            .onSet(this.setTargetTemperature.bind(this))
            .onGet(this.getTargetTemperature.bind(this))
            .setProps({
                minValue: this.minValue,
                maxValue: this.maxValue,
                minStep: THERMOSTAT_TARGET_TEMP_STEP_VALUE,
            })
            .updateValue(this.targetTemperature);

        this.service.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
            .onGet(this.getOutletTemperature.bind(this))
            .updateValue(this.outletTemperature)
            .setProps({
                minValue: THERMOSTAT_CURRENT_TEMP_MIN_VALUE,
                maxValue: THERMOSTAT_CURRENT_TEMP_MAX_VALUE,
                minStep: THERMOSTAT_CURRENT_TEMP_STEP_VALUE,
            });

        this.service.getCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState)
            .updateValue(this.platform.Characteristic.TargetHeatingCoolingState.HEAT)
            .setProps({
                minValue: this.platform.Characteristic.TargetHeatingCoolingState.HEAT,
                maxValue: this.platform.Characteristic.TargetHeatingCoolingState.HEAT,
                validValues: [this.platform.Characteristic.TargetHeatingCoolingState.HEAT],
            });

        this.service.getCharacteristic(this.platform.Characteristic.CurrentHeatingCoolingState)
            .onGet(this.getIsRunning.bind(this))
            .updateValue(this.isRunning ? this.platform.Characteristic.CurrentHeatingCoolingState.HEAT
                : this.platform.Characteristic.CurrentHeatingCoolingState.OFF)
            .setProps({
                minValue: this.platform.Characteristic.CurrentHeatingCoolingState.OFF,
                maxValue: this.platform.Characteristic.CurrentHeatingCoolingState.HEAT,
                validValues: [this.platform.Characteristic.CurrentHeatingCoolingState.OFF, this.platform.Characteristic.CurrentHeatingCoolingState.HEAT],
            });
    }

    bindRecirculation(isPrimary: boolean): Service | undefined {
        if (this.accessory.context.info?.recirculation_capable === API_VALUE_TRUE) {
            this.platform.log.debug(`Device ${this.accessory.context.id} has recirculation capabilities. Adding service.`);
            const recircService = this.accessory.getService(RECIRC_SERVICE_NAME) ||
                this.accessory.addService(this.platform.Service.Switch, RECIRC_SERVICE_NAME, `${this.accessory.context.id}-Recirculation`);
            recircService.getCharacteristic(this.platform.Characteristic.On)
                .onSet(this.setRecirculateActive.bind(this))
                .onGet(this.getRecirculateActive.bind(this));
            recircService.updateCharacteristic(this.platform.Characteristic.On, this.accessory.context.shadow.recirculation_enabled);
            if (isPrimary) {
                recircService.setCharacteristic(this.platform.Characteristic.Name, this.accessory.context.device_name);
            }
            return recircService;
        } else {
            this.platform.log.debug(`Device ${this.accessory.context.id} does not support recirculation.`);
            return undefined;
        }
    }

    bindStaticValues() {
        this.service.updateCharacteristic(this.platform.Characteristic.TemperatureDisplayUnits,
            this.platform.getConfig().temperatureUnits === TemperatureUnits.F
                ? this.platform.Characteristic.TemperatureDisplayUnits.FAHRENHEIT
                : this.platform.Characteristic.TemperatureDisplayUnits.CELSIUS);
    }

    async setRecirculateActive(value: CharacteristicValue) {
        const duration = (value as boolean) ? `${this.platform.getConfig().recirculationDuration}`
            : '0';
        this.platform.log.info(`setRecirculateActive to ${value} for device ${this.accessory.context.id}`);

        const state: Record<string, string | boolean> = {
            [API_KEY_SET_PRIORITY_STATUS]: true,
            [API_KEY_RECIRCULATION_DURATION]: duration,
            [API_KEY_SET_RECIRCULATION_ENABLED]: (value as boolean),
        };
        await this.platform.setState(this.accessory, state);
    }

    async retrieveMaintenanceInfo() {
        const state: Record<string, string | number | boolean> = {
            [API_KEY_DO_MAINTENANCE_RETRIEVAL]: true,
        };

        await this.platform.setState(this.accessory, state);
    }

    accessoryToControllerTemperature(value: number): number {
        let convertedValue: number = this.isFahrenheit ? celsiusToFahrenheit(value) : value;
        if (this.isFahrenheit) {
            if (convertedValue < WATER_HEATER_BIG_STEP_START_IN_F) {
                convertedValue = Math.round(convertedValue / WATER_HEATER_SMALL_STEP_VALUE_IN_F) * WATER_HEATER_SMALL_STEP_VALUE_IN_F;
            } else {
                convertedValue = Math.round(convertedValue / WATER_HEATER_BIG_STEP_VALUE_IN_F) * WATER_HEATER_BIG_STEP_VALUE_IN_F;
            }
        } else {
            convertedValue = Math.round(convertedValue);
        }

        convertedValue = Math.max(this.platform.getConfig().minimumTemperature as number, convertedValue);
        convertedValue = Math.min(this.platform.getConfig().maximumTemperature as number, convertedValue);

        return convertedValue;
    }

    async setTargetTemperature(value: CharacteristicValue) {
        this.platform.log.info(`Water Heater ${this.accessory.context.id}: HomeKit sets target temperature to ${value}C`);

        const convertedValue = this.accessoryToControllerTemperature(value as number);
        this.platform.log.info(`Water Heater ${this.accessory.context.id}: Sending converted/rounded temperature: ` +
                               `${convertedValue}${this.platform.getConfig().temperatureUnits}`);

        const state: Record<string, string | number | boolean> = {
            [API_KEY_SET_PRIORITY_STATUS]: true,
            [API_KEY_SET_TEMPERATURE]: convertedValue,
        };

        await this.platform.setState(this.accessory, state);

        setTimeout(() => {
            this.platform.throttledPoll();
        }, SET_STATE_WAIT_TIME_MILLIS);

        this.targetTemperature = this.isFahrenheit ? fahrenheitToCelsius(convertedValue) : convertedValue;
    }

    async pollBasicInfo() {
        await this.platform.throttledPoll();
        this.extractDeviceInfo();
    }

    async pollMaintenanceInfo() {
        await this.retrieveMaintenanceInfo();
        await this.platform.throttledPoll();
        this.extractDeviceInfo();
    }

    public pollMaintenanceInfoWhenIdling = _.throttle(this.pollMaintenanceInfo, MAINTENANCE_RETRIEVAL_IDLING_THROTTLE_MILLIS);
    public pollMaintenanceInfoWhenRunning = _.throttle(this.pollMaintenanceInfo, MAINTENANCE_RETRIEVAL_RUNNING_THROTTLE_MILLIS);

    async getTargetTemperature(): Promise<Nullable<CharacteristicValue>> {
        await this.pollBasicInfo();
        return this.targetTemperature;
    }

    async getOutletTemperature(): Promise<Nullable<CharacteristicValue>> {
        if (this.isRunning) {
            await this.pollMaintenanceInfoWhenRunning();
        } else {
            await this.pollMaintenanceInfoWhenIdling();
        }
        return this.outletTemperature;
    }

    async getIsRunning(): Promise<Nullable<CharacteristicValue>> {
        await this.pollBasicInfo();
        return this.isRunning;
    }

    async getRecirculateActive(): Promise<Nullable<CharacteristicValue>> {
        await this.pollBasicInfo();
        return this.accessory.context.shadow.recirculation_enabled;
    }
}
