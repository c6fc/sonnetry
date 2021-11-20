{
	local aws = self,

	client(service, params={}):: {
		service: service,
		params: params
	},

	api(clientObj, method, params=""):: std.native("aws")(
		std.manifestJsonEx(clientObj, ''),
		method,
		std.manifestJsonEx(params, '')
	),

	getCallerIdentity():: aws.api(aws.client('STS'), 'getCallerIdentity'),

	getRegionsList():: std.map(
		function (x)
			local log = std.native("log")("region");

			x.RegionName,
		aws.api(aws.client('EC2'), "describeRegions").Regions
	),

	getAvailabilityZones():: {
		[region]: std.map(
			function (x) x.ZoneName,
			aws.api(aws.client('EC2', { region: region }), "describeAvailabilityZones").AvailabilityZones
		) for region in aws.regions()
	},


}