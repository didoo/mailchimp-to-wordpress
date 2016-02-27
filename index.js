var request = require('request');
var cheerio = require('cheerio');
var _ = require('underscore');
var chalk = require('chalk');

var config = require('./config.js');

var mailchimpOpts = {
    method: 'GET',
    url: config.mailchimpArchiveUrl + '&show=' + config.mailchimpArchiveShow
};

console.log(chalk.bold.green('### STARTED ###'));

request(mailchimpOpts, function (error, response, jscode) {
    console.log('getting list of issues from Mailchimp');
    if (!error && response.statusCode == 200) {

        var issuesURL = [];

        var htmlcode = '<html><body>' + eval(jscode.replace(/^document.write\(/,'').replace(/\);$/,'')) + '</body></html>';
        var $ = cheerio.load(htmlcode);
        $('.campaign a').each(function(i,elem){
            issuesURL.push($(elem).attr('href'));
        });

         // debug: trim the array
        // issuesURL.length = 4;

       console.log('you have ' + chalk.bold.cyan(issuesURL.length) + ' issues in Mailchimp\'s archive');

        var wpOptsList = {
            method: 'GET',
            url: config.wpApiUrl + '/posts',
            json: true
        };

        request(wpOptsList, function (error, response, posts) {
            console.log('getting list of posts from Wordpress');
            if (!error && response.statusCode == 200) {

                var postsIssueURL = [];

                // get already saved issues/posts using the 'mailchimp_url' meta as identifier
                posts.forEach(function(post){
                    if(post.mailchimp_url && post.mailchimp_url.length > 0) {
                        postsIssueURL.push(post.mailchimp_url[0]);
                    }
                });

                console.log('you have ' + chalk.bold.yellow(postsIssueURL.length) + ' issues in Wordpress');

                // get the issues that have not yet been saved
                var issuesMissing = _.difference(issuesURL, postsIssueURL);

                console.log('going to add ' + chalk.bold.magenta(issuesMissing.length) + ' issues to Wordpress');

                issuesMissing.forEach(function(issueURL){
                    console.log(chalk.bold.green('>>> importing issue ' + issueURL));
                    request({method:'GET',url:issueURL,normalizeWhitespace:true}, function (error, response, htmlcode) {
                        if (!error && response.statusCode == 200) {

                            var $ = cheerio.load(htmlcode);
                            // store the issue date
                            var issueDate = $('#templateHeader h5').text().replace(/^Issue: /,'');
                            // store the issue categories
                            var issueTags = [];
                            $('#templateColumns h5').each(function(i, el) { // this is a Cheerio each!
                                var tag = $(el).text().trim();
                                if(tag) {
                                    issueTags.push(tag);
                                }
                            });
                            // remove the header, footer and other strange things
                            $('#templatePreheader').remove();
                            $('#templateHeader').remove();
                            $('#templateFooter').remove();
                            $('#awesomewrap').remove();
                            // cleanup all inline styles, decoration attributes, etc.
                            $('[style]').removeAttr('style');
                            $('[width]').removeAttr('width');
                            $('[height]').removeAttr('height');
                            $('[align]').removeAttr('align');
                            $('[valign]').removeAttr('valign');
                            $('[cellspacing]').removeAttr('cellspacing');
                            $('[cellpadding]').removeAttr('cellpadding');
                            $('[border]').removeAttr('border');
                            // get the residual HTML chunk (and assign a class for the version of the template)
                            htmlchunk = '<table id="#templateContainer" class="v1">' + $('body #templateContainer').html() + '</table>';
                            // strip invisible spacing characters (e.g. &#xA0;)
                            htmlchunk = htmlchunk.replace(/&#xA0;/g,' ');

                            // get the issue date in different formats (the RFL date is in dd-mm-yy format)
                            var issueDateParts = issueDate.split('/');
                            var issueDateIso = new Date('20' + issueDateParts[2], issueDateParts[1]-1, issueDateParts[0], '12', '30', '00'); // Note: months are 0-based
                            // replace the numeric month with a string
                            issueDateParts[1] = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][(issueDateParts[1]-1)];
                            // expose the full year
                            issueDateParts[2] = '20' + issueDateParts[2];

                            // add the tags to the taxonomy (if not exist yet)
                            var issueTagsId = [];
                            issueTags.forEach(
                                function(tag) {

                                    // prepare the wp-post data
                                    var wpOptsTags = {
                                        method: 'POST',
                                        url: config.wpApiUrl + '/tags',
                                        headers: { 'Authorization': 'Basic ' + Buffer(config.wpAppUser + ':' + config.wpAppPass).toString('base64') },
                                        json: true,
                                        body: { name: tag }
                                    };

                                    request(wpOptsTags, function (error, response, body) {
                                        if (!error && response.statusCode == 201) { // HTTP code = created
                                            console.log('tag ' + chalk.bold.white(tag) + ' created');
                                            issueTagsId.push(body.id);
                                        } else {
                                            if(body.code == 'term_exists') {
                                                console.log('tag ' + tag + ' already exist');
                                                issueTagsId.push(body.data);
                                            } else {
                                                console.log('response: ', response.statusCode);
                                                console.log('error dump: ', error);
                                                console.log('body: ', body);
                                            }
                                        }
                                    });

                                }
                            );

                            // prepare the wp-post data
                            var wpOptsCreate = {
                                method: 'POST',
                                url: config.wpApiUrl + '/posts',
                                headers: { 'Authorization': 'Basic ' + Buffer(config.wpAppUser + ':' + config.wpAppPass).toString('base64') },
                                json: true,
                                body: {
                                    date: issueDateIso,
                                    slug: issueDateParts.join('-').toLowerCase(),
                                    title: 'Readings for Lunch — [ ' + issueDateParts.join(' ') + ' ]',
                                    content: htmlchunk,
                                    status: 'publish',
                                    comment_status: 'closed',
                                    format: 'standard',
                                    tags: issueTagsId,
                                    // post_meta: [{ 'mailchimp_url' : issueURL }], // not working anymore :(
                                    author: 1
                                }
                            };

                            // create the post
                            request(wpOptsCreate, function (error, response, body) {
                                if (!error && response.statusCode == 201) { // HTTP code = created
                                    console.log('posted issue ' + chalk.bold.blue(issueDate) + ' (' + chalk.bold.white('ID #' + body.id) + ') - ' + body.link);

                                    var postId = body.id;

                                    // prepare the meta data
                                    var wpOptsMeta = {
                                        method: 'POST',
                                        url: config.wpApiUrl + '/posts/' + postId + '/meta',
                                        headers: { 'Authorization': 'Basic ' + Buffer(config.wpAppUser + ':' + config.wpAppPass).toString('base64') },
                                        json: true,
                                        body: {
                                            key: 'mailchimp_url',
                                            value : issueURL
                                        }
                                    };

                                    // post the the meta data
                                    request(wpOptsMeta, function (error, response, body) {
                                        if (!error && response.statusCode == 201) { // HTTP code = created
                                            console.log('posted metadata for ID #' + postId);
                                        } else {
                                            console.log(chalk.bold.red('post metadata for ID #' + postId + ' failed'));
                                            console.log('response: ', response);
                                            console.log('error dump: ', error);
                                        }
                                    });

                                } else {
                                    console.log(chalk.bold.red('post to WP failed with code'));
                                    console.log('response: ', response);
                                    console.log('error dump: ', error);
                                }

                            });

                        }
                    });
                });

            }
        });

    }
});