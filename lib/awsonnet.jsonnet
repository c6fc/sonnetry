local aws = import 'aws.libsonnet';

{
	local client = aws.client('EC2', { region: "us-west-2" }),

	regions: std.map(
		function (x)
			local log = std.native("log")("region");

			x.RegionName,
		aws.api(client, "describeRegions").Regions
	),
	availabilityZones():: {
		[region]: std.map(
			function (x) x.ZoneName,
			aws.api(aws.client('EC2', { region: region }), "describeAvailabilityZones").AvailabilityZones
		) for region in $.regions
	},
}