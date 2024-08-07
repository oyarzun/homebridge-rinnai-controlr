import {
    API as HomebridgeAPI,
    Characteristic,
    DynamicPlatformPlugin,
    Logger,
    PlatformAccessory,
    PlatformConfig,
    Service,
} from 'homebridge';

import {PLATFORM_NAME, PLUGIN_NAME} from './settings';
import {RinnaiControlrPlatformAccessory} from './platformAccessory';
import Amplify, {Auth} from '@aws-amplify/auth';
import API, {graphqlOperation} from '@aws-amplify/api-graphql';
import {
    API_KEY,
    API_POLL_THROTTLE_MILLIS,
    GET_DEVICES_QUERY,
    GRAPHQL_ENDPOINT, PREVIOUS_UUID_SUFFICES,
    REGION,
    SHADOW_ENDPOINT_PREFIX, SHADOW_ENDPOINT_SUFFIX,
    TemperatureUnits,
    USER_POOL_ID,
    USER_POOL_WEB_CLIENT_ID, UUID_SUFFIX,
} from './constants';
import _ from 'lodash';

type RinnaiControlrConfig = {
    username: string;
    password: string;
    recirculationDuration: number;
    temperatureUnits: TemperatureUnits;
    minimumTemperature: number;
    maximumTemperature: number;
    recirculationOnly: boolean;
} & PlatformConfig;

/**
 * HomebridgePlatform
 * This class is the main constructor for your plugin, this is where you should
 * parse the user config and discover/register accessories with Homebridge.
 */
export class RinnaiControlrHomebridgePlatform implements DynamicPlatformPlugin {
    public readonly Service: typeof Service = this.api.hap.Service;
    public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;

    // this is used to track restored cached accessories
    public readonly accessories: PlatformAccessory[] = [];
    private initializedAccessories: string[] = [];

    constructor(
        public readonly log: Logger,
        public readonly config: PlatformConfig,
        public readonly api: HomebridgeAPI,
    ) {
        this.log.debug('Finished initializing platform:', this.config.name);

        // When this event is fired it means Homebridge has restored all cached accessories from disk.
        // Dynamic Platform plugins should only register new accessories after this event was fired,
        // in order to ensure they weren't added to homebridge already. This event can also be used
        // to start discovery of new accessories.
        this.api.on('didFinishLaunching', () => {
            log.debug('Executed didFinishLaunching callback');
            if (this.getConfig().temperatureUnits === TemperatureUnits.F) {
                this.log.info('Temperature units set to F. All values from config and from Rinnai will be converted to C.');
            } else {
                this.log.info('Temperature units set to C. All values from config and from Rinnai will not be converted.');
            }
            // run the method to discover / register your devices as accessories
            this.initializeAmplifyClient();
            this.initializeSession()
                .then(() => this.throttledPoll());
        });
    }

    /**
     * This function is invoked when homebridge restores cached accessories from disk at startup.
     * It should be used to setup event handlers for characteristics and update respective values.
     */
    configureAccessory(accessory: PlatformAccessory) {
        this.log.debug('Loading accessory from cache:', accessory.displayName);
        if (this.removeBrokenAccessories(accessory.context)) {
            this.log.warn('Removed accessory:', accessory.displayName);
        } else {
            this.accessories.push(accessory);
        }
    }

    initializeAmplifyClient() {
        Amplify.configure({
            Auth: {
                region: REGION,
                userPoolId: USER_POOL_ID,
                userPoolWebClientId: USER_POOL_WEB_CLIENT_ID,
            },
        });
        API.configure({
            region: REGION,
            aws_appsync_authenticationType: 'API_KEY', //TODO: 'AMAZON_COGNITO_USER_POOLS',
            aws_appsync_graphqlEndpoint: GRAPHQL_ENDPOINT,
            aws_appsync_apiKey: API_KEY,
        });
    }

    async initializeSession() {
        try {
            const user = await Auth.signIn(this.getConfig().username, this.getConfig().password);
            this.log.debug(`Session initialized successfully for user: ${JSON.stringify(user)}`);
        } catch (error) {
            this.log.error('Caught error authenticating.', error);
        }
    }

    getConfig(): RinnaiControlrConfig {
        return this.config as RinnaiControlrConfig;
    }

    async setState(accessory: PlatformAccessory, state: Record<string, string | number | boolean>) {
        try {
            const session = await Auth.currentSession();
            const url = `${SHADOW_ENDPOINT_PREFIX}${accessory.context['thing_name']}${SHADOW_ENDPOINT_SUFFIX}`;
            const request = {
                method: 'PATCH',
                body: JSON.stringify(state),
                headers: {
                    'User-Agent': 'okhttp/3.12.1',
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Accept-Encoding': 'gzip',
                    'Accept': 'application/json, text/plain, */*',
                    'Authorization': `Bearer ${session.getIdToken().getJwtToken()}`,
                },
            };
            this.log.debug(`Sending state to Rinnai. Endpoint: ${url} Request: ${JSON.stringify(request)}`);
            const response = await fetch(url, request);
            this.log.debug(`Set state responded with ${response.status} ${response.statusText}. Body: ${JSON.stringify(response)}`);
        } catch (error) {
            this.log.error('Caught error setting state.', error);
        }
    }

    /**
     * Poll for devices. This is used both in discovering devices and in fetching device state.
     */
    pollDeviceStatus() {
        this.log.debug('Polling devices...');
        Auth.currentSession().then(session => {
            const authToken = session.getAccessToken().getJwtToken();

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (API.graphql(graphqlOperation(GET_DEVICES_QUERY, {email: this.getConfig().username}, authToken)) as Promise<any>).then(response => {
                if (!response?.data?.getUserByEmail?.items) {
                    this.log.error(`Invalid response received from Rinnai: ${JSON.stringify(response)}`);
                    return;
                }
                const devices = response.data.getUserByEmail.items.reduce((accumulator, value) => accumulator.concat(value.devices?.items), [])
                    .filter(device => device);

                if (devices.length === 0) {
                    this.log.error(`Found 0 device from Rinnai. Check response: ${JSON.stringify(response, null, 2)}`);
                    return;
                }

                this.log.debug(`Found ${devices.length} Rinnai devices.`);
                // loop over the discovered devices and register each one if it has not already been registered
                for (const device of devices) {
                    this.log.debug(`Processing device: ${JSON.stringify(device, null, 2)}`);

                    this.removeBrokenAccessories(device);

                    this.log.debug(`Generating UUID from S/N ${device.id}`);
                    const uuid = this.generateAccessoryUuid(device, UUID_SUFFIX);

                    // see if an accessory with the same uuid has already been registered and restored from
                    // the cached devices we stored in the `configureAccessory` method above
                    let accessory = this.accessories.find(accessory => accessory.UUID === uuid);

                    if (accessory) {
                        // the accessory already exists
                        this.log.debug('Restoring existing accessory from cache:', accessory.displayName);

                        // if you need to update the accessory.context then you should run `api.updatePlatformAccessories`. eg.:
                        accessory.context = device;
                        this.api.updatePlatformAccessories([accessory]);

                        if (!this.initializedAccessories.find(accessoryUuid => accessoryUuid === uuid)) {
                            // create the accessory handler for the restored accessory
                            // this is imported from `platformAccessory.ts`
                            new RinnaiControlrPlatformAccessory(this, accessory);
                            this.initializedAccessories.push(accessory.UUID);
                        }
                    } else {
                        // the accessory does not yet exist, so we need to create it
                        this.log.debug(`Adding new accessory because ${accessory} was not restored from cache:`, device.device_name);

                        // create a new accessory
                        accessory = new this.api.platformAccessory(device.device_name, uuid);

                        // store a copy of the device object in the `accessory.context`
                        // the `context` property can be used to store any data about the accessory you may need
                        accessory.context = device;

                        this.accessories.push(accessory);

                        // create the accessory handler for the newly create accessory
                        // this is imported from `platformAccessory.ts`
                        new RinnaiControlrPlatformAccessory(this, accessory);

                        // link the accessory to your platform
                        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
                        this.initializedAccessories.push(accessory.UUID);
                    }
                }

                this.log.debug(`Polled ${devices.length} Rinnai devices successfully.`);
            }).catch(error => {
                this.log.error('Could not poll Rinnai devices', error);
            });

        }).catch(error => {
            this.log.debug('Failed to fetch session', error);
        });
    }

    public throttledPoll = _.throttle(async () => {
        await this.pollDeviceStatus();
    }, API_POLL_THROTTLE_MILLIS);

    generateAccessoryUuid(device, uuidSuffix: string): string {
        switch (uuidSuffix) {
            case '-1':
                return this.api.hap.uuid.generate(`${device.dsn}${uuidSuffix}`);
            case '-2':
                return this.api.hap.uuid.generate(`${device.id}${uuidSuffix}`);
        }

        throw new Error('Unknown suffix');
        return 'bad-uuid';
    }

    removeBrokenAccessories(device): boolean {
        let removed = false;
        PREVIOUS_UUID_SUFFICES.forEach(uuidSuffix => {
            const oldUuid = this.generateAccessoryUuid(device, uuidSuffix);
            const oldAccessory = this.accessories.find(accessory => accessory.UUID === oldUuid);
            if (oldAccessory) {
                this.log.info(`Removing existing accessory from cache because of breaking change: ${oldAccessory.displayName}`);
                this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [oldAccessory]);
                removed = true;
            }
        });
        return removed;
    }
}
